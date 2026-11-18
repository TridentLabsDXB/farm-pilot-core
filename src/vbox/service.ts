// V-BOX data source (Data sources > V-BOX, shown as a TAB inside the MQTT Payload page). V-BOX data arrives over MQTT through the ONE broker connection of the MQTT Payload source;
// this class only adds its own subscription (topic filter) and tag mapping, and removes only those. It is a data source of its own in the licence (1), NOT part of the MQTT source.
// MqttSourceService calls matches() / handle() for every message; nothing here can throw into the MQTT client: invalid JSON, unmapped tags and unknown units are counted and shown.
// Licence: PRO or higher (licence/dataSources.ts). Without it messages are NOT ingested (they show "licence" in LATEST MESSAGES); stored data stays.
import { EventEmitter } from "node:events";
import type { Db } from "../db.js";
import { audit } from "../db.js";
import type { Ingest } from "../ingest.js";
import { HttpError } from "../gateway/registry.js";
import { checkFilter, getPath, parseTs, topicMatches } from "../mqtt/mapping.js";
import { plcVboxServiceState, requirePlcVbox, type DataSourceAccess } from "../licence/dataSources.js";
import type { LicenceSummary } from "../licence/summary.js";
import { checkMapsTo, farmPointOptions, syncFarmPoints } from "../mapped/index.js";
import { VBOX_DEFAULT_FILTER, VBOX_DEFAULT_FORMAT, VBOX_DEFAULT_ID, VBOX_DEFAULT_TAGS, VBOX_SERIES_TOPIC } from "./defaults.js";

type Actor = { username: string; role: string };
export interface VboxLicence { summary(): LicenceSummary; checkDataSourceAdd(n?: number): void; }
export const SCHEMA_VBOX = `
CREATE TABLE IF NOT EXISTS vbox_config (id INTEGER PRIMARY KEY CHECK (id=1), enabled INTEGER NOT NULL DEFAULT 0, topic_filter TEXT NOT NULL, format TEXT NOT NULL,
  id_from TEXT NOT NULL CHECK (id_from IN ('topic','payload')), id_level INTEGER NOT NULL, id_path TEXT NOT NULL, ts_path TEXT NOT NULL DEFAULT 'ts');
CREATE TABLE IF NOT EXISTS vbox_tags (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE, unit TEXT NOT NULL DEFAULT '', scale REAL NOT NULL DEFAULT 1, offset REAL NOT NULL DEFAULT 0,
  maps_to TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS vbox_units (unit_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('new','added','ignored')), first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0);
`;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, UNIT = /^[A-Za-z0-9_.:-]{1,64}$/, RING = 20, RAW_CAP = 2000;
interface Msg { ts: number; topic: string; raw: string; status: "ok" | "unmapped" | "error"; unit: string | null; notes: string[]; stored: boolean; }

/** Pure: reads the V-BOX unit id and the tag values of one message. Never throws. */
export function parseVbox(topic: string, payload: Buffer | string, o: { idFrom: "topic" | "payload"; idLevel: number; idPath: string; tsPath: string; tags: { path: string; name: string; unit: string; scale: number; offset: number }[] }) {
  const res = { status: "ok" as "ok" | "unmapped" | "error", unit: null as string | null, ts: null as number | null, values: [] as { tag: string; name: string; unit: string; value: number }[], missing: [] as string[], unmapped: [] as string[], errors: [] as string[] };
  let p: unknown; try { p = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8")); } catch { res.errors.push("invalid JSON"); res.status = "error"; return res; }
  if (p === null || typeof p !== "object" || Array.isArray(p)) { res.errors.push("payload is not a JSON object"); res.status = "error"; return res; }
  if (o.idFrom === "topic") { const id = topic.split("/")[o.idLevel - 1]; if (id && UNIT.test(id)) res.unit = id; else res.errors.push(`no V-BOX id at topic level ${o.idLevel}`); }
  else { const f = getPath(p, o.idPath); if (f.found && (typeof f.value === "string" || (typeof f.value === "number" && Number.isSafeInteger(f.value))) && UNIT.test(String(f.value))) res.unit = String(f.value); else res.errors.push(`V-BOX id field "${o.idPath}" is missing or has a wrong type`); }
  res.ts = parseTs(getPath(p, o.tsPath).value);
  const covered = new Set<string>([o.tsPath, ...(o.idFrom === "payload" ? [o.idPath] : [])]);
  for (const t of o.tags) {
    covered.add(t.path); const f = getPath(p, t.path);
    if (!f.found) { res.missing.push(t.path); continue; }
    if (typeof f.value !== "number" || !Number.isFinite(f.value)) { res.errors.push(`tag "${t.path}" must be a number`); continue; }
    const v = f.value * t.scale + t.offset; if (!Number.isFinite(v)) { res.errors.push(`tag "${t.path}" gives no finite value`); continue; }
    res.values.push({ tag: t.path, name: t.name, unit: t.unit, value: v });
  }
  const all: string[] = []; const walk = (v: unknown, pre: string, d: number) => { if (all.length >= 200) return; if (v && typeof v === "object" && d < 4) for (const [k, x] of Object.entries(v)) walk(x, pre ? `${pre}.${k}` : k, d + 1); else if (pre) all.push(pre); }; walk(p, "", 0);
  res.unmapped = all.filter((l) => ![...covered].some((c) => l === c || l.startsWith(c + ".")));
  res.status = res.errors.length ? "error" : res.unmapped.length ? "unmapped" : "ok"; return res;
}

export class VboxSource extends EventEmitter {
  private messages: Msg[] = []; private errors = 0; private last = new Map<string, { value: number; ts: number; unit: string }>(); private delta = new Map<string, { n: number; at: number }>(); private unmapped = new Map<string, number>();
  now = () => Date.now();
  constructor(private db: Db, private ingest: Ingest, private licence: VboxLicence) {
    super(); db.exec(SCHEMA_VBOX);
    if (!db.prepare("SELECT 1 FROM vbox_config").get()) db.transaction(() => {
      db.prepare("INSERT INTO vbox_config(id,enabled,topic_filter,format,id_from,id_level,id_path) VALUES(1,0,?,?,?,?,?)").run(VBOX_DEFAULT_FILTER, VBOX_DEFAULT_FORMAT, VBOX_DEFAULT_ID.from, VBOX_DEFAULT_ID.level, VBOX_DEFAULT_ID.path);
      VBOX_DEFAULT_TAGS.forEach((t, i) => db.prepare("INSERT INTO vbox_tags(path,name,unit,scale,offset,sort) VALUES(?,?,?,?,?,?)").run(t.path, t.name, t.unit, t.scale, t.offset, i));
    })();
  }
  private cfg() { return this.db.prepare("SELECT * FROM vbox_config WHERE id=1").get() as any; }
  private tags() { return this.db.prepare("SELECT path,name,unit,scale,offset,maps_to FROM vbox_tags ORDER BY sort,id").all() as { path: string; name: string; unit: string; scale: number; offset: number; maps_to: string }[]; }
  access(): DataSourceAccess { return plcVboxServiceState(this.licence.summary(), this.now()); }
  /** The topic filter MQTT must subscribe to for this source, or null (source off, or licence stopped it). */
  subscription(): string | null { const c = this.cfg(); return c.enabled && this.access().run ? c.topic_filter : null; }
  /** True when this topic belongs to the V-BOX preset (even when the source is off: OTHER DEVICES shows only what does NOT match). */
  matches(topic: string): boolean { return topicMatches(this.cfg().topic_filter, topic); }

  /** Called by MqttSourceService for every message that matches(). Returns the log entry; never throws. */
  handle(topic: string, payload: Buffer, now = this.now()): { status: Msg["status"]; device: string | null; notes: string[]; stored: boolean } {
    const c = this.cfg(), acc = this.access(), notes: string[] = [];
    try {
      const m = parseVbox(topic, payload, { idFrom: c.id_from, idLevel: c.id_level, idPath: c.id_path, tsPath: c.ts_path, tags: this.tags() });
      notes.push(...m.errors); if (m.missing.length) notes.push("missing: " + m.missing.join(", ")); if (m.unmapped.length) notes.push("unmapped: " + m.unmapped.slice(0, 8).join(", "));
      if (m.status === "error") this.errors++; for (const u of m.unmapped) if (this.unmapped.size < 100 || this.unmapped.has(u)) this.unmapped.set(u, (this.unmapped.get(u) ?? 0) + 1);
      let stored = false;
      if (!c.enabled) notes.push("V-BOX source is off");
      else if (!acc.run) notes.push("licence: V-BOX needs PRO or higher, not ingested");
      else if (m.unit) {
        const row = this.db.prepare("SELECT state FROM vbox_units WHERE unit_id=?").get(m.unit) as { state: string } | undefined;
        if (!row) this.db.prepare("INSERT INTO vbox_units(unit_id,state,first_seen,last_seen,msg_count) VALUES(?, 'new', ?, ?, 0)").run(m.unit, now, now);
        const d = this.delta.get(m.unit) ?? { n: 0, at: now }; d.n++; d.at = now; this.delta.set(m.unit, d);
        if (row?.state === "added" && m.values.length) { this.ingest.record(VBOX_SERIES_TOPIC, m.unit, Object.fromEntries(m.values.map((v) => [v.name, v.value])), m.ts ?? now); for (const v of m.values) this.last.set(`${m.unit}|${v.tag}`, { value: v.value, ts: now, unit: v.unit }); stored = true; }
        else notes.push(row?.state === "ignored" ? "unit ignored" : row?.state === "added" ? "no value stored" : "unit not added yet");
      }
      this.messages.unshift({ ts: now, topic, raw: payload.toString("utf8").slice(0, RAW_CAP), status: m.status, unit: m.unit, notes, stored }); if (this.messages.length > RING) this.messages.length = RING;
      this.emit("update"); return { status: m.status, device: m.unit, notes, stored };
    } catch (e) { this.errors++; console.error("vbox: handle", e); return { status: "error", device: null, notes: ["internal error"], stored: false }; }
  }
  private flush() { if (!this.delta.size) return; const up = this.db.prepare("UPDATE vbox_units SET msg_count=msg_count+?, last_seen=? WHERE unit_id=?"); this.db.transaction(() => { for (const [id, d] of this.delta) up.run(d.n, d.at, id); })(); this.delta.clear(); }

  view() {
    this.flush(); const c = this.cfg(), acc = this.access(), now = this.now();
    return {
      access: acc,
      preset: { enabled: !!c.enabled, topic_filter: c.topic_filter, format: c.format, id_from: c.id_from, id_level: c.id_level, id_path: c.id_path, ts_path: c.ts_path, status: c.enabled ? "APPLIED" : "OFF" },
      units: (this.db.prepare("SELECT unit_id,state,first_seen,last_seen,msg_count FROM vbox_units ORDER BY first_seen").all() as any[]).map((u) => ({ ...u, tag_count: [...this.last.keys()].filter((k) => k.startsWith(u.unit_id + "|")).length })),
      tags: this.tags().map((t) => ({ ...t, readings: [...this.last].filter(([k]) => k.endsWith("|" + t.path)).map(([k, v]) => ({ unit: k.split("|")[0], value: v.value, age_s: Math.round((now - v.ts) / 1000) })) })),
      unmapped: [...this.unmapped].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count).slice(0, 20), errors: this.errors,
      messages: this.messages.map(({ raw, ...m }) => ({ ...m, payload: raw })),
      farm_points: farmPointOptions(this.db), note: "This source counts as 1 data source in the licence.",
    };
  }
  private checkAccess(adding: boolean) { return requirePlcVbox(this.licence.summary(), adding, this.now()); }
  savePreset(a: Actor, i: Record<string, any>) {
    this.checkAccess(false); const c = this.cfg();
    const filter = i.topic_filter ?? c.topic_filter, format = i.format ?? c.format, from = i.id_from ?? c.id_from, level = i.id_level ?? c.id_level, path = i.id_path ?? c.id_path;
    const bad = checkFilter(filter); if (bad) throw new HttpError(400, bad);
    if (typeof format !== "string" || !format.trim() || format.length > 64) throw new HttpError(400, "payload format is a short label");
    if (from !== "topic" && from !== "payload") throw new HttpError(400, "device ID comes from the topic or the payload");
    if (!Number.isInteger(level) || level < 1 || level > 16) throw new HttpError(400, "topic level must be 1 to 16");
    if (typeof path !== "string" || !PATH.test(path)) throw new HttpError(400, "device ID field must look like id or device.id");
    this.db.prepare("UPDATE vbox_config SET topic_filter=?,format=?,id_from=?,id_level=?,id_path=? WHERE id=1").run(filter, format.trim(), from, level, path);
    audit(this.db, a.username, a.role, "vbox.preset", { topic_filter: filter, id_from: from, id_level: level, id_path: path }); this.emit("resubscribe"); this.emit("update"); return this.view();
  }
  /** Enabling counts 1 data source (403 on FREE, 409 at the limit). Disabling removes only this source's subscription and rules' effect, never the MQTT Payload source. */
  setEnabled(a: Actor, on: unknown) {
    if (typeof on !== "boolean") throw new HttpError(400, "enabled must be true or false");
    this.checkAccess(on); if (on && !this.cfg().enabled) this.licence.checkDataSourceAdd(1);
    this.db.prepare("UPDATE vbox_config SET enabled=? WHERE id=1").run(on ? 1 : 0); audit(this.db, a.username, a.role, on ? "vbox.enable" : "vbox.disable", {}); this.emit("resubscribe"); this.emit("update"); return this.view();
  }
  setUnit(a: Actor, id: string, action: "add" | "ignore" | "remove") {
    this.checkAccess(false); this.flush(); if (!UNIT.test(id)) throw new HttpError(400, "bad V-BOX id"); if (!this.db.prepare("SELECT 1 FROM vbox_units WHERE unit_id=?").get(id)) throw new HttpError(404, "V-BOX unit not found");
    if (action === "remove") { this.db.prepare("DELETE FROM vbox_units WHERE unit_id=?").run(id); for (const k of [...this.last.keys()]) if (k.startsWith(id + "|")) this.last.delete(k); }       // stored measurements stay
    else this.db.prepare("UPDATE vbox_units SET state=? WHERE unit_id=?").run(action === "add" ? "added" : "ignored", id);
    audit(this.db, a.username, a.role, `vbox.unit.${action}`, { unit: id }); this.emit("update"); return this.view();
  }
  saveTags(a: Actor, tags: unknown, tsPath?: unknown) {
    this.checkAccess(false); if (!Array.isArray(tags) || tags.length > 60) throw new HttpError(400, "tags must be a list of at most 60 rows");
    const ts = tsPath === undefined ? this.cfg().ts_path : tsPath; if (typeof ts !== "string" || !PATH.test(ts)) throw new HttpError(400, "timestamp field must look like ts or meta.ts");
    const paths = new Set<string>(), names = new Set<string>();
    for (const [i, t] of tags.entries()) {
      const n = `row ${i + 1}`;
      if (!t || typeof t.path !== "string" || !PATH.test(t.path) || t.path.length > 80) throw new HttpError(400, `${n}: tag path must look like gh1_temp or data.temp`);
      if (typeof t.name !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(t.name)) throw new HttpError(400, `${n}: name must be lower case letters, digits or _ (max 32)`);
      if (typeof t.unit !== "string" || t.unit.length > 12) throw new HttpError(400, `${n}: unit is at most 12 characters`);
      if (typeof t.scale !== "number" || !Number.isFinite(t.scale) || t.scale === 0 || Math.abs(t.scale) > 1e9) throw new HttpError(400, `${n}: scale must be a number other than 0`);
      if (typeof t.offset !== "number" || !Number.isFinite(t.offset) || Math.abs(t.offset) > 1e9) throw new HttpError(400, `${n}: offset must be a number`);
      try { t.maps_to = checkMapsTo(this.db, t.maps_to, n); } catch (e) { throw new HttpError(400, (e as Error).message); }
      if (paths.has(t.path)) throw new HttpError(400, `${n}: tag ${t.path} is mapped twice`); paths.add(t.path); if (names.has(t.name)) throw new HttpError(400, `${n}: measurement ${t.name} is used twice`); names.add(t.name);
    }
    this.db.transaction(() => { this.db.prepare("UPDATE vbox_config SET ts_path=? WHERE id=1").run(ts); this.db.prepare("DELETE FROM vbox_tags").run(); tags.forEach((t: any, i) => this.db.prepare("INSERT INTO vbox_tags(path,name,unit,scale,offset,maps_to,sort) VALUES(?,?,?,?,?,?,?)").run(t.path, t.name, t.unit, t.scale, t.offset, t.maps_to ?? "", i)); })();
    syncFarmPoints(this.db); this.unmapped.clear(); this.errors = 0; audit(this.db, a.username, a.role, "vbox.tags", { rows: tags.length }); this.emit("update"); return this.view();
  }
}
