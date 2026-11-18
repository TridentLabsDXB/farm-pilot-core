// PLC data source (Data sources > PLC). READ ONLY: this file never builds a write request; the reader it uses exposes read functions only (test/plc.test.ts fails if a write code is ever produced).
// One PLC link, one request queue (a private one for Modbus TCP, the shared RS-485 port queue for RTU), zones read one after another every poll interval. The PLC link never blocks the rest of CORE:
// every read is caught, counted and shown. OFFLINE only after OFFLINE_CYCLES failed poll cycles in a row (a cycle fails when no zone answered). Values are stored as normal measurements (series topic plc/modbus).
// Licence: PLC needs PRO or higher (licence/dataSources.ts). A licence problem only stops this source, never another one, and never deletes data.
import { EventEmitter } from "node:events";
import type { Db } from "../db.js";
import { audit } from "../db.js";
import type { Ingest } from "../ingest.js";
import { HttpError } from "../gateway/registry.js";
import { ModbusMaster, ModbusException } from "../drivers/modbus/master.js";
import { createTransport } from "../drivers/modbus/transport.js";
import { ModbusBadFrame, ModbusTimeout } from "../drivers/modbus/frames.js";
import type { PortManager } from "../ports/manager.js";
import { plcVboxServiceState, requirePlcVbox, type DataSourceAccess } from "../licence/dataSources.js";
import type { LicenceSummary } from "../licence/summary.js";
import { AREAS, checkPoints, POINT_TYPES, STYLES, zoneRequest, type Area, type PointDef, type Style } from "./address.js";
import { decodePoint, type WordOrder } from "./decode.js";
import { SCHEMA_PLC, PLC_SERIES_TOPIC } from "./schema.js";
import { checkMapsTo, farmPointOptions, syncFarmPoints } from "../mapped/index.js";

export { PLC_SERIES_TOPIC };
export const OFFLINE_CYCLES = 3;
export type PlcLink = "disabled" | "connecting" | "online" | "offline" | "locked";
export type ZoneStatus = "OK" | "NO ANSWER" | "BAD DATA" | "DISABLED" | "NOT READ";
type Actor = { username: string; role: string };
/** What the service needs from Modbus: read functions ONLY. */
export interface PlcReader { readRegs(fc: 3 | 4, addr: number, count: number): Promise<number[]>; readBits(fc: 1 | 2, addr: number, count: number): Promise<number[]>; close(): Promise<void>; }
export interface PlcLicence { summary(): LicenceSummary; checkDataSourceAdd(n?: number): void; }
export type ReaderFactory = (cfg: PlcConfigRow) => PlcReader | null;
export interface PlcConfigRow { enabled: number; protocol: "tcp" | "rtu" | "other"; host: string; port: number; unit: number; rtu_port_id: number | null; poll_s: number; timeout_ms: number; word_order: WordOrder; }
interface ZoneRow { id: number; code: string; name: string; farm_zone_id: number | null; area: Area; start: number; length: number; style: Style; enabled: number; sort: number; }
interface PointRow { id: number; zone_id: number; off: number; name: string; type: PointDef["type"]; scale: number; unit: string; maps_to: string; }
interface ZoneLive { status: ZoneStatus; reason: string | null; lastAt: number | null; values: Record<string, number | null>; }

/** Plain reason text for a failed read ("timeout: no reply", "exception 02: illegal data address"). Pure. */
export function reasonOf(e: unknown): { status: ZoneStatus; reason: string } {
  const EX: Record<number, string> = { 1: "illegal function", 2: "illegal data address", 3: "illegal data value", 4: "device failure", 6: "device busy" };
  if (e instanceof ModbusException) return { status: "BAD DATA", reason: `exception ${String(e.code).padStart(2, "0")}: ${EX[e.code] ?? "device reported an error"}` };
  if (e instanceof ModbusBadFrame) return { status: "BAD DATA", reason: String(e.message) };
  if (e instanceof ModbusTimeout) return { status: "NO ANSWER", reason: /timeout|no reply|short reply/i.test(e.message) ? e.message.replace(/ \(FC.*\)$/, "") : "timeout: " + e.message };
  const m = String((e as Error)?.message ?? e); return /short or wrong-sized|unexpected function/i.test(m) ? { status: "BAD DATA", reason: m } : { status: "NO ANSWER", reason: m.slice(0, 120) };
}
/** Link state machine, pure: returns the new consecutive-failure count and whether the PLC counts as offline. */
export const nextLink = (fails: number, cycleOk: boolean) => { const f = cycleOk ? 0 : fails + 1; return { fails: f, offline: f >= OFFLINE_CYCLES }; };
export const backoff = (fails: number, pollMs: number) => (fails >= OFFLINE_CYCLES ? Math.max(pollMs, Math.min(60_000, 1000 * 2 ** Math.min(fails - OFFLINE_CYCLES + 1, 6))) : pollMs);

export class PlcService extends EventEmitter {
  private reader: PlcReader | null = null; private readerKey = ""; private timer: NodeJS.Timeout | null = null; private stopped = true; private fails = 0; private link: PlcLink = "disabled";
  private live = new Map<number, ZoneLive>(); private lastPollAt: number | null = null; private busy = false;
  now = () => Date.now();
  constructor(private db: Db, private ingest: Ingest, private licence: PlcLicence, private ports: () => PortManager | null = () => null, private factory?: ReaderFactory) {
    super(); db.exec(SCHEMA_PLC); if (!db.prepare("SELECT 1 FROM plc_config").get()) db.prepare("INSERT INTO plc_config(id) VALUES(1)").run();
  }
  // ---------- storage ----------
  cfg(): PlcConfigRow { return this.db.prepare("SELECT * FROM plc_config WHERE id=1").get() as PlcConfigRow; }
  zones(): ZoneRow[] { return this.db.prepare("SELECT * FROM plc_zones ORDER BY sort,id").all() as ZoneRow[]; }
  private zone(id: number): ZoneRow { const z = this.db.prepare("SELECT * FROM plc_zones WHERE id=?").get(id) as ZoneRow | undefined; if (!z) throw new HttpError(404, "data zone not found"); return z; }
  points(zoneId: number): PointRow[] { return this.db.prepare("SELECT * FROM plc_points WHERE zone_id=? ORDER BY off").all(zoneId) as PointRow[]; }
  access(): DataSourceAccess { return plcVboxServiceState(this.licence.summary(), this.now()); }

  // ---------- reader ----------
  private makeReader(c: PlcConfigRow): PlcReader | null {
    if (this.factory) return this.factory(c);
    let m: ModbusMaster | null = null;
    if (c.protocol === "tcp") { if (!c.host) return null; m = new ModbusMaster(createTransport({ type: "tcp", host: c.host, port: c.port }), { unit: c.unit, timeoutMs: c.timeout_ms, retries: 0 }); }
    else if (c.protocol === "rtu") { if (c.rtu_port_id === null) return null; m = this.ports()?.plcMaster(c.rtu_port_id, c.unit) ?? null; }
    if (!m) return null; const mm = m, own = c.protocol === "tcp";
    return { readRegs: (fc, a, n) => mm.read(fc, a, n), readBits: (fc, a, n) => mm.readBits(fc, a, n), close: () => (own ? mm.close() : Promise.resolve()) };
  }
  private async getReader(): Promise<PlcReader | null> {
    const c = this.cfg(), key = JSON.stringify([c.protocol, c.host, c.port, c.unit, c.rtu_port_id, c.timeout_ms]);
    if (this.reader && key !== this.readerKey) await this.dropReader();
    if (!this.reader) { this.reader = this.makeReader(c); this.readerKey = key; } return this.reader;
  }
  private async dropReader() { const r = this.reader; this.reader = null; await r?.close().catch(() => {}); }

  // ---------- reading ----------
  /** One zone, all its requests. Throws the first failure. */
  private async readZone(r: PlcReader, z: ZoneRow): Promise<number[]> {
    const req = zoneRequest(z), out: number[] = [];
    for (const c of req.chunks) out.push(...(c.fc <= 2 ? await r.readBits(c.fc as 1 | 2, c.offset, c.count) : await r.readRegs(c.fc as 3 | 4, c.offset, c.count)));
    return out;
  }
  private decode(z: ZoneRow, raw: number[], order: WordOrder) {
    const values: Record<string, number | null> = {}; for (const p of this.points(z.id)) values[p.name] = decodePoint(z.area, raw, { offset: p.off, name: p.name, type: p.type, scale: p.scale, unit: p.unit }, order); return values;
  }
  /** One poll cycle: every enabled zone in turn. Never throws. Stores values of zones that answered. */
  async pollOnce(): Promise<{ ok: boolean }> {
    const c = this.cfg(); let ok = false, tried = 0;
    try {
      const r = await this.getReader(); const now = this.now();
      for (const z of this.zones()) {
        if (!z.enabled) { this.live.set(z.id, { status: "DISABLED", reason: null, lastAt: this.live.get(z.id)?.lastAt ?? null, values: {} }); continue; }
        tried++;
        if (!r) { this.live.set(z.id, { status: "NO ANSWER", reason: c.protocol === "other" ? "protocol OTHER is not available yet" : "connection settings are incomplete", lastAt: null, values: {} }); continue; }
        try {
          const raw = await this.readZone(r, z), values = this.decode(z, raw, c.word_order), num: Record<string, number> = {};
          for (const [k, v] of Object.entries(values)) if (v !== null) num[k] = v;
          if (Object.keys(num).length) this.ingest.record(PLC_SERIES_TOPIC, z.code, num, now);
          this.live.set(z.id, { status: "OK", reason: null, lastAt: now, values }); ok = true;
        } catch (e) { const x = reasonOf(e); this.live.set(z.id, { status: x.status, reason: x.reason, lastAt: this.live.get(z.id)?.lastAt ?? null, values: {} }); }
      }
    } catch (e) { console.error("plc: poll", e); }
    this.lastPollAt = this.now();
    if (tried > 0) { const n = nextLink(this.fails, ok); this.fails = n.fails; this.link = n.offline ? "offline" : ok ? "online" : this.link === "online" ? "online" : "connecting"; }
    else this.link = "online" === this.link ? "online" : "connecting";
    this.emit("update"); return { ok };
  }
  /** READ ZONE NOW: one read, the exact request and the raw registers. NOTHING is stored. */
  async readNow(a: Actor, id: number) {
    requirePlcVbox(this.licence.summary(), false, this.now()); const z = this.zone(id), req = zoneRequest(z), c = this.cfg();
    if (c.protocol === "other") throw new HttpError(409, "protocol OTHER is not available yet");
    const r = await this.getReader(); if (!r) throw new HttpError(409, "the connection settings are incomplete");
    audit(this.db, a.username, a.role, "plc.read_zone", { zone: z.code });
    try { const raw = await this.readZone(r, z); return { ok: true, request: req, raw, values: this.decode(z, raw, c.word_order), at: this.now() }; }
    catch (e) { const x = reasonOf(e); return { ok: false, request: req, raw: [] as number[], values: {}, status: x.status, reason: x.reason, at: this.now() }; }
  }
  /** TEST: first enabled zone (or one register) read once. Stores nothing. */
  async test(a: Actor) {
    requirePlcVbox(this.licence.summary(), false, this.now()); const c = this.cfg();
    if (c.protocol === "other") return { ok: false, message: "Protocol OTHER is not available yet." };
    const r = await this.getReader(); if (!r) return { ok: false, message: "The connection settings are incomplete." };
    audit(this.db, a.username, a.role, "plc.test", {});
    try { await r.readRegs(3, 0, 1); return { ok: true, message: "The PLC answered." }; } catch (e) { const x = reasonOf(e); return x.status === "BAD DATA" && /^exception/.test(x.reason) ? { ok: true, message: `The PLC answered (${x.reason}).` } : { ok: false, message: x.reason }; }
  }

  // ---------- lifecycle ----------
  start() { this.stopped = false; this.schedule(1000); }
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; await this.dropReader(); }
  private schedule(ms: number) { if (this.stopped) return; this.timer = setTimeout(() => void this.tick(), ms); this.timer.unref?.(); }
  private async tick() {
    if (this.busy) return; this.busy = true; let next = this.cfg().poll_s * 1000;
    try {
      const c = this.cfg(), acc = this.access();
      if (!c.enabled) { this.link = "disabled"; this.fails = 0; }
      else if (!acc.run) { this.link = "locked"; }               // licence ended: no polling, no ingest, nothing deleted
      else { await this.pollOnce(); next = backoff(this.fails, next); }
    } catch (e) { console.error("plc: tick", e); } finally { this.busy = false; this.schedule(next); }
  }

  // ---------- API ----------
  view() {
    const c = this.cfg(), acc = this.access(), now = this.now(), link: PlcLink = !c.enabled ? "disabled" : !acc.run ? "locked" : this.link;
    return {
      access: acc,
      config: { enabled: !!c.enabled, protocol: c.protocol, host: c.host, port: c.port, unit: c.unit, rtu_port_id: c.rtu_port_id, poll_s: c.poll_s, timeout_ms: c.timeout_ms, word_order: c.word_order },
      status: { link, lastPollAt: this.lastPollAt, failedCycles: this.fails, lastPollAgeS: this.lastPollAt ? Math.round((now - this.lastPollAt) / 1000) : null },
      zones: this.zones().map((z) => this.zoneView(z)),
      ports: (this.ports()?.view().ports ?? []).map((p: any) => ({ id: p.id, name: p.name ?? `Port ${p.id}` })),
      farm_zones: this.db.prepare("SELECT id,name FROM zones ORDER BY sort,name").all(), farm_points: farmPointOptions(this.db),
      note: "This source counts as 1 data source in the licence.",
    };
  }
  private zoneView(z: ZoneRow) {
    let request: ReturnType<typeof zoneRequest> | null = null, error: string | null = null; try { request = zoneRequest(z); } catch (e) { error = (e as Error).message; }
    const l = this.live.get(z.id), pts = this.points(z.id);
    return { id: z.id, code: z.code, name: z.name, farm_zone_id: z.farm_zone_id, area: z.area, start: z.start, length: z.length, style: z.style, enabled: !!z.enabled, request, error,
      status: z.enabled ? l?.status ?? "NOT READ" : "DISABLED", reason: l?.reason ?? null, lastAt: l?.lastAt ?? null,
      points: pts.map((p) => ({ offset: p.off, name: p.name, type: p.type, scale: p.scale, unit: p.unit, maps_to: p.maps_to, value: l?.values[p.name] ?? null })) };
  }
  private checkConn(i: Record<string, unknown>, cur: PlcConfigRow) {
    const protocol = (i.protocol ?? cur.protocol) as string, host = (i.host ?? cur.host) as unknown, port = (i.port ?? cur.port) as number, unit = (i.unit ?? cur.unit) as number;
    const poll = (i.poll_s ?? cur.poll_s) as number, tmo = (i.timeout_ms ?? cur.timeout_ms) as number, wo = (i.word_order ?? cur.word_order) as string, rp = i.rtu_port_id === undefined ? cur.rtu_port_id : (i.rtu_port_id as number | null);
    if (!["tcp", "rtu", "other"].includes(protocol)) throw new HttpError(400, "protocol must be Modbus TCP, Modbus RTU or OTHER");
    if (typeof host !== "string" || (host !== "" && !/^[A-Za-z0-9._:-]{1,253}$/.test(host.trim()))) throw new HttpError(400, "PLC address must be a host name or IP address");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "port must be 1 to 65535");
    if (!Number.isInteger(unit) || unit < 0 || unit > 255) throw new HttpError(400, "unit ID must be 0 to 255");
    if (!Number.isInteger(poll) || poll < 1 || poll > 3600) throw new HttpError(400, "poll interval must be 1 to 3600 seconds");
    if (!Number.isInteger(tmo) || tmo < 200 || tmo > 30000) throw new HttpError(400, "timeout must be 200 to 30000 ms");
    if (!["big", "little"].includes(wo)) throw new HttpError(400, "word order must be big or little");
    if (rp !== null && !Number.isInteger(rp)) throw new HttpError(400, "RS-485 port must be a port number");
    return { protocol, host: host.trim(), port, unit, poll, tmo, wo, rp: rp ?? null };
  }
  /** CONNECTION SETTINGS. Changing a PLC source is refused on FREE (403, tier message). */
  async saveConfig(a: Actor, i: Record<string, unknown>) {
    requirePlcVbox(this.licence.summary(), false, this.now()); const v = this.checkConn(i, this.cfg());
    this.db.prepare("UPDATE plc_config SET protocol=?,host=?,port=?,unit=?,rtu_port_id=?,poll_s=?,timeout_ms=?,word_order=?,updated_at=?,updated_by=? WHERE id=1").run(v.protocol, v.host, v.port, v.unit, v.rp, v.poll, v.tmo, v.wo, this.now(), a.username);
    audit(this.db, a.username, a.role, "plc.config", { protocol: v.protocol, host: v.host, port: v.port, unit: v.unit, rtu_port_id: v.rp, poll_s: v.poll, word_order: v.wo });
    await this.dropReader(); this.fails = 0; return this.view();
  }
  /** Enabling counts 1 data source: refused with 403 on FREE, with 409 at the tier limit. */
  async setEnabled(a: Actor, on: unknown) {
    if (typeof on !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const acc = requirePlcVbox(this.licence.summary(), on, this.now());
    if (on && !this.cfg().enabled) this.licence.checkDataSourceAdd(1);
    if (on && acc.state === "grace") throw new HttpError(403, "PLC and V-BOX need a PRO licence or higher. Upload a licence on the About page.");
    this.db.prepare("UPDATE plc_config SET enabled=? WHERE id=1").run(on ? 1 : 0); audit(this.db, a.username, a.role, on ? "plc.enable" : "plc.disable", {});
    this.fails = 0; this.link = on ? "connecting" : "disabled"; if (!on) await this.dropReader(); this.emit("update"); return this.view();
  }
  private cleanZone(i: Record<string, any>, cur?: ZoneRow) {
    const name = i.name ?? cur?.name, area = i.area ?? cur?.area, style = i.style ?? cur?.style ?? "plc", start = i.start ?? cur?.start, length = i.length ?? cur?.length;
    const fz = i.farm_zone_id === undefined ? cur?.farm_zone_id ?? null : i.farm_zone_id;
    if (typeof name !== "string" || !name.trim() || name.length > 64) throw new HttpError(400, "name is required, at most 64 characters");
    if (!AREAS.includes(area)) throw new HttpError(400, "area must be holding, input, coils or discrete"); if (!STYLES.includes(style)) throw new HttpError(400, "address style must be plc or protocol");
    try { zoneRequest({ area, style, start, length }); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (fz !== null && (!Number.isInteger(fz) || !this.db.prepare("SELECT 1 FROM zones WHERE id=?").get(fz))) throw new HttpError(400, "farm zone not found");
    return { name: name.trim(), area: area as Area, style: style as Style, start: start as number, length: length as number, farm_zone_id: fz as number | null, enabled: i.enabled === undefined ? (cur?.enabled ?? 1) : i.enabled ? 1 : 0 };
  }
  private cleanPoints(area: Area, length: number, pts: unknown): PointDef[] & { maps_to?: string }[] {
    if (!Array.isArray(pts)) throw new HttpError(400, "points must be a list"); if (pts.length > 200) throw new HttpError(400, "at most 200 points per zone");
    const list = pts.map((p: any) => ({ offset: p?.offset, name: p?.name, type: p?.type, scale: p?.scale ?? 1, unit: p?.unit ?? "", maps_to: "" as string }));
    const bad = checkPoints(area, length, list); if (bad) throw new HttpError(400, bad);
    list.forEach((q, i) => { try { q.maps_to = checkMapsTo(this.db, (pts[i] as any)?.maps_to, `point ${i + 1}`); } catch (e) { throw new HttpError(400, (e as Error).message); } }); return list;
  }
  /** + ADD DATA ZONE / SAVE ZONE. Adding or changing zones is refused on FREE. */
  saveZone(a: Actor, id: number | null, body: Record<string, any>) {
    requirePlcVbox(this.licence.summary(), false, this.now()); const cur = id === null ? undefined : this.zone(id), z = this.cleanZone(body, cur);
    const pts = body.points === undefined ? (cur ? this.points(cur.id).map((p) => ({ offset: p.off, name: p.name, type: p.type, scale: p.scale, unit: p.unit, maps_to: p.maps_to })) : []) : this.cleanPoints(z.area, z.length, body.points);
    if (body.points === undefined && cur) { const bad = checkPoints(z.area, z.length, pts as PointDef[]); if (bad) throw new HttpError(400, "the existing points no longer fit: " + bad); }
    let zid = cur?.id ?? 0;
    this.db.transaction(() => {
      if (!cur) {
        const n = (this.db.prepare("SELECT COUNT(*) c FROM plc_zones").get() as { c: number }).c; if (n >= 64) throw new HttpError(400, "at most 64 data zones");
        let k = n + 1; while (this.db.prepare("SELECT 1 FROM plc_zones WHERE code=?").get("DZ" + k)) k++;
        zid = Number(this.db.prepare("INSERT INTO plc_zones(code,name,farm_zone_id,area,start,length,style,enabled,sort) VALUES(?,?,?,?,?,?,?,?,?)").run("DZ" + k, z.name, z.farm_zone_id, z.area, z.start, z.length, z.style, z.enabled, k).lastInsertRowid);
      } else this.db.prepare("UPDATE plc_zones SET name=?,farm_zone_id=?,area=?,start=?,length=?,style=?,enabled=? WHERE id=?").run(z.name, z.farm_zone_id, z.area, z.start, z.length, z.style, z.enabled, cur.id);
      if (body.points !== undefined || cur) { this.db.prepare("DELETE FROM plc_points WHERE zone_id=?").run(zid); for (const p of pts as any[]) this.db.prepare("INSERT INTO plc_points(zone_id,off,name,type,scale,unit,maps_to) VALUES(?,?,?,?,?,?,?)").run(zid, p.offset, p.name, p.type, p.scale, p.unit, p.maps_to ?? ""); }
    })();
    syncFarmPoints(this.db);
    audit(this.db, a.username, a.role, cur ? "plc.zone.update" : "plc.zone.add", { zone: this.zone(zid).code, area: z.area, start: z.start, length: z.length, points: pts.length }); this.live.delete(zid); this.emit("update"); return this.view();
  }
  deleteZone(a: Actor, id: number) { requirePlcVbox(this.licence.summary(), false, this.now()); const z = this.zone(id); this.db.prepare("DELETE FROM plc_zones WHERE id=?").run(id); syncFarmPoints(this.db); this.live.delete(id); audit(this.db, a.username, a.role, "plc.zone.delete", { zone: z.code }); return this.view(); }
}
export { POINT_TYPES };
