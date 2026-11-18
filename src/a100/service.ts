// 2026-11-18 -- CONTROL DEVICES > Ashining A100: the link (one bus_devices row of kind fan_link, exclusive on its port), the devices behind it, the commands and WRITE TO UNIT.
// Honest status (core-control-devices-ashining-a100-page.md): SENT = the frame was written to the A100. The radio ACK between the two modules is NOT reported to the host, so it never means CONFIRMED.
// CONFIRMED needs real feedback from the receiver side or the VFD, and that protocol is not known yet: TODO(fan-feedback) -- confirmFromFeedback() exists, nothing calls it. Without feedback a
// SENT command becomes UNKNOWN after `unknownAfterMs`. Never RUNNING.
// TODO(fan-payload): the command frames for the fans (receiver addressing, VFD frame, retries) are NOT defined here. A device only gets a command when its Admin-entered payload (hex) exists for that
// command; the service wraps it (target transmission prefix) and writes it. Nothing is invented: with no payload the command is refused with a plain sentence. Find the Online / EDGE protocol first.
// The AES key is never stored, logged, audited, returned or shown: SET NEW KEY writes it to the unit and forgets it; READ FROM UNIT only learns whether the unit still has the factory key.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { audit, type Db } from "../db.js";
import { HttpError, type Actor } from "../gateway/registry.js";
import type { PortManager, DeviceState } from "../ports/manager.js";
import { validateAssignment, validateDevice } from "../ports/validate.js";
import { A100Error, A100Link, type UnitParams } from "./link.js";
import { targetPrefix } from "./frames.js";
import { AIR_KBPS, BAUDS, encodeAck, encodeBaud, encodeFormat, encodeRadio, MAX_CHANNEL, OFFERED_MODES, POWER_DBM, REG, REG_LEN, setOption, decodeRadio, decodeFormat, decodeAck } from "./registers.js";

export const SCHEMA_A100 = `
CREATE TABLE IF NOT EXISTS a100_link (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT, prev TEXT, snapshot_at INTEGER, answered_at INTEGER, updated_at INTEGER, updated_by TEXT);
CREATE TABLE IF NOT EXISTS a100_devices (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fan', role TEXT, zone_id INTEGER, scope TEXT NOT NULL DEFAULT 'site',
  dest_group INTEGER NOT NULL DEFAULT 0, dest_addr INTEGER NOT NULL DEFAULT 0, channel INTEGER NOT NULL DEFAULT 0, rate_limit_s INTEGER NOT NULL DEFAULT 10, enabled INTEGER NOT NULL DEFAULT 1,
  payloads TEXT NOT NULL DEFAULT '{}');   -- { "<command>": "<hex>" } entered by the Admin; TODO(fan-payload): none shipped
CREATE TABLE IF NOT EXISTS a100_commands (
  id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, command TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','unknown','confirmed','failed')), note TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
`;
/** Reboot / factory restore stay off until verified on a real unit (core-control-devices-a100-manual-verification.md). */
export const RESET_ENABLED = false;
export const DEVICE_KINDS = ["fan", "valve", "actuator", "other"] as const;
export type CmdStatus = "sent" | "unknown" | "confirmed" | "failed";
const int = (v: unknown, lo: number, hi: number, what: string) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`); return n; };

export class A100Service extends EventEmitter {
  link: A100Link; private inflight = 0; private timer?: NodeJS.Timeout; private lastRead: UnitParams | null = null;
  /** After this long without feedback a SENT command is shown as UNKNOWN. */
  unknownAfterMs = 30_000;
  /** The link counts as answering when the unit answered a register read within this time. */
  answeringWithinMs = 120_000;
  now = () => Date.now();
  constructor(private db: Db, private ports: () => PortManager | null, opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}) {
    super(); db.exec(SCHEMA_A100); db.prepare("INSERT OR IGNORE INTO a100_link(id) VALUES(1)").run();
    this.link = new A100Link(() => this.transport(), opts);
    const row = db.prepare("SELECT snapshot FROM a100_link WHERE id=1").get() as { snapshot: string | null }; try { this.lastRead = row.snapshot ? JSON.parse(row.snapshot) : null; } catch { this.lastRead = null; }
  }
  private fanRow() { return this.ports()?.store.devices().find((d) => d.kind === "fan_link") ?? null; }
  private transport() { const d = this.fanRow(), pm = this.ports(); if (!d || !d.enabled || !pm || !pm.store.port(d.port_id)?.enabled) return null; return pm.queueOf(d.port_id)?.tr ?? null; }

  // ---------- lifecycle ----------
  /** A light liveness read (version) every 60 s while the link is on, so the lamp is real. Never started by tests. */
  start() { const pm = this.ports(); if (pm) pm.fanLinkState = () => this.deviceState(); this.timer = setInterval(() => { if (this.transport() && !this.inflight) void this.readLive().catch(() => {}); }, 60_000); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); }
  private async readLive() { await this.link.readRssi(); this.markAnswered(); }
  private markAnswered() { this.db.prepare("UPDATE a100_link SET answered_at=? WHERE id=1").run(this.now()); this.emit("update"); }
  private answeredAt(): number | null { return (this.db.prepare("SELECT answered_at a FROM a100_link WHERE id=1").get() as { a: number | null }).a; }
  linkAnswering() { const a = this.answeredAt(); return !!this.transport() && a !== null && this.now() - a < this.answeringWithinMs; }
  deviceState(): DeviceState { if (!this.transport()) return "not_connected"; const a = this.answeredAt(); return a === null ? "unknown" : this.linkAnswering() ? "online" : "offline"; }

  // ---------- the link row ----------
  /** Assign the A100 to a port (and switch the link on or off). The bus_devices row is created here; validation = the Ports rules (exclusive on its port, no address). */
  setLink(a: Actor, body: Record<string, unknown>) {
    const pm = this.ports(); if (!pm) throw new HttpError(503, "ports are not available"); const old = this.fanRow();
    const port_id = body.port_id === undefined ? old?.port_id : int(body.port_id, 1, 9, "port"), enabled = body.enabled === undefined ? old?.enabled ?? false : !!body.enabled;
    if (port_id === undefined) throw new HttpError(400, "choose the RS-485 port the A100 is connected to");
    const next = { id: old?.id ?? 0, kind: "fan_link" as const, model: "A100-L400M30", port_id, modbus_address: 0, poll_interval_s: 60, enabled };
    const others = pm.store.devices().filter((d) => d.id !== old?.id), errs = [...validateDevice(next, pm.store.ports()), ...validateAssignment([...others, { ...next, id: next.id || -1 }])];
    if (errs.length) throw new HttpError(400, errs.join("; "), { errors: errs });
    if (old && old.port_id === port_id && old.enabled === enabled) return { ok: true, unchanged: true };
    pm.store.upsertFanLink(port_id, enabled);
    audit(this.db, a.username, a.role, "a100.link.update", { old: old ? { port: old.port_id, enabled: old.enabled } : null, new: { port: port_id, enabled } });
    this.emit("update"); return { ok: true };
  }

  // ---------- READ, TEST ----------
  async readFromUnit(a: Actor) {
    const first = this.lastRead === null;
    try { const p = await this.link.readParams(); this.lastRead = p; this.db.prepare("UPDATE a100_link SET snapshot=?, snapshot_at=?, answered_at=? WHERE id=1").run(JSON.stringify(p), this.now(), this.now());
      audit(this.db, a.username, a.role, "a100.read", { version: p.version, missing: p.missing }); this.emit("update"); return { ok: true, params: p, first, warnings: this.warnings(p) };
    } catch (e) { throw this.httpOf(e); }
  }
  private httpOf(e: unknown) { return e instanceof HttpError ? e : e instanceof A100Error ? new HttpError(e.kind === "no_answer" || e.kind === "no_link" ? 502 : 409, e.message) : new HttpError(500, String((e as Error)?.message ?? e)); }
  warnings(p: UnitParams | null = this.lastRead) {
    const w: { code: string; text: string }[] = []; if (!p) return w;
    if (p.defaultKey === true) w.push({ code: "default_key", text: "DEFAULT KEY IN USE: the unit still has the factory encryption key. Set a new key; it must be changed on both ends of the link." });
    if (p.options?.remoteConfig) w.push({ code: "remote_config", text: "Remote configuration is ON: other modules in range can reconfigure this unit. Switch it off unless a planned change needs it." });
    const m = this.serialMismatch(p); if (m) w.push({ code: "serial_mismatch", text: m });
    return w;
  }
  serialMismatch(p: UnitParams | null = this.lastRead): string | null {
    const d = this.fanRow(), port = d && this.ports()?.store.port(d.port_id); if (!p || !port) return null; const bad: string[] = [];
    if (p.baud !== null && p.baud !== port.baud) bad.push(`baud ${p.baud} on the unit, ${port.baud} on the port`);
    if (p.format) { if (p.format.parity !== port.parity) bad.push(`parity ${p.format.parity} on the unit, ${port.parity} on the port`); if (p.format.stopBits !== port.stop_bits) bad.push(`stop bits ${p.format.stopBits} on the unit, ${port.stop_bits} on the port`); if (p.format.dataBits !== port.data_bits) bad.push(`data bits ${p.format.dataBits} on the unit, ${port.data_bits} on the port`); }
    return bad.length ? "SERIAL MISMATCH: " + bad.join("; ") + ". The A100 and the port must use the same serial settings." : null;
  }
  /** TEST LINK: the port opens, the A100 answers a register read, the serial registers match the port. It writes only register READ frames (checked in the tests): no data frame, no command to any fan. */
  async testLink(a: Actor) {
    const checks: { name: string; ok: boolean; text: string }[] = []; const d = this.fanRow(), pm = this.ports(), port = d && pm?.store.port(d.port_id);
    if (!d || !port) checks.push({ name: "PORT", ok: false, text: "No RS-485 port is assigned to the A100." });
    else if (!d.enabled || !port.enabled) checks.push({ name: "PORT", ok: false, text: !d.enabled ? "The link is switched off." : "The port is switched off on the RS-485 Ports page." });
    else {
      const ls = pm!.queueOf(port.id)?.tr.linkState?.(); const tr = this.transport();
      if (port.transport === "serial" && ls?.state === "error") checks.push({ name: "PORT", ok: false, text: `The port could not be opened: ${ls.error}` }); else checks.push({ name: "PORT", ok: !!tr, text: tr ? "The port is open." : "The port has no connection." });
      if (tr) {
        try { const v = await this.link.readVersion(); this.markAnswered(); checks.push({ name: "A100 ANSWERS", ok: true, text: `The unit answered (${v}).` });
          try { const p = await this.link.readParams(); this.lastRead = p; this.db.prepare("UPDATE a100_link SET snapshot=?, snapshot_at=? WHERE id=1").run(JSON.stringify(p), this.now()); const m = this.serialMismatch(p); checks.push({ name: "SERIAL MATCH", ok: !m, text: m ?? "The unit's serial registers match the port settings." }); } catch { checks.push({ name: "SERIAL MATCH", ok: false, text: "The serial registers could not be read." }); }
        } catch (e) { checks.push({ name: "A100 ANSWERS", ok: false, text: e instanceof A100Error ? e.message : String(e) }); }
      }
    }
    const ok = checks.length > 0 && checks.every((c) => c.ok); audit(this.db, a.username, a.role, "a100.test", { ok, checks: checks.map((c) => `${c.name}:${c.ok}`) }); this.emit("update");
    return { ok, checks, note: "TEST LINK sends no command to any fan or other device." };
  }

  // ---------- WRITE TO UNIT, SET NEW KEY, REBOOT, FACTORY ----------
  /** Changes are named fields (channel, powerDbm, airKbps, mode, ackEnabled, ackRetries, retryMs, localGroup, localAddress, destGroup, destAddress, packetLen, packTimeMs, remoteConfig, baud, format).
   *  Needs confirm = true (the page says a wrong radio or serial setting can cut the link to the fans), a READ FROM UNIT first (the old values are kept for REVERT), and no command in flight.
   *  Each register is written, read back and compared; on any failure everything written is put back from the kept values. Nothing is set automatically: only what the Admin sent. */
  async writeToUnit(a: Actor, body: Record<string, unknown>) {
    if (body.confirm !== true) throw new HttpError(400, "confirm that a wrong radio or serial setting can cut the link to the fans");
    const old = this.lastRead; if (!old) throw new HttpError(409, "READ FROM UNIT first: CORE keeps those values so it can put them back (REVERT)");
    if (this.inflight > 0) throw new HttpError(409, "a command is still being sent: wait until it is written before changing the unit");
    const ch = (body.changes ?? {}) as Record<string, unknown>; const plan = this.plan(old, ch, body.confirmRemote === true);
    if (!plan.length) return { ok: true, unchanged: true, written: [] as string[] };
    this.inflight++; const done: { reg: number; was: Buffer }[] = []; const written: string[] = [];
    try {
      for (const w of plan) {
        const was = Buffer.from(old.raw[w.reg] ?? "", "hex");
        try { await this.link.writeReg(w.reg, w.data); done.push({ reg: w.reg, was }); written.push(w.name);
          if (w.reg === REG.BAUD || w.reg === REG.FORMAT) continue;      // the serial side changes under us: it cannot be read back at the old port settings (see the note in the result)
          const back = await this.link.readReg(w.reg); if (!back.equals(w.data)) throw new A100Error("refused", `${w.name}: the unit answered with a different value after the write`);
        } catch (e) { const reverted = await this.putBack(done); audit(this.db, a.username, a.role, "a100.write.failed", { fields: plan.map((p) => p.name), error: (e as Error).message, reverted });
          throw new HttpError(409, `${(e as Error).message}. ${reverted ? "The earlier values were put back." : "The earlier values could NOT be put back: check the link, or use configuration mode (RESET lamp) or the AS_DS tool."}`, { reverted }); }
      }
      this.db.prepare("UPDATE a100_link SET prev=? WHERE id=1").run(JSON.stringify(old));      // the values before this write: what REVERT goes back to
      const fresh = await this.link.readParams().catch(() => null); if (fresh) { this.lastRead = fresh; this.db.prepare("UPDATE a100_link SET snapshot=?, snapshot_at=?, answered_at=? WHERE id=1").run(JSON.stringify(fresh), this.now(), this.now()); }
      audit(this.db, a.username, a.role, "a100.write", { changes: plan.map((p) => ({ field: p.name, old: p.before, new: p.after })) }); this.emit("update");
      const serial = plan.some((p) => p.reg === REG.BAUD || p.reg === REG.FORMAT);
      return { ok: true, written, params: fresh, serialChanged: serial, note: serial ? "The unit's serial side changed. Change SERIAL SIDE to match and press READ FROM UNIT; until then the link may not answer." : undefined };
    } finally { this.inflight--; }
  }
  private async putBack(done: { reg: number; was: Buffer }[]) { let ok = true; for (const d of [...done].reverse()) { try { if (d.was.length) await this.link.writeReg(d.reg, d.was); } catch { ok = false; } } return ok; }
  /** REVERT: write the values kept at the last READ FROM UNIT back for the registers named. Same confirmation as WRITE. */
  async revert(a: Actor, body: Record<string, unknown>) {
    if (body.confirm !== true) throw new HttpError(400, "confirm the revert"); const row = this.db.prepare("SELECT prev FROM a100_link WHERE id=1").get() as { prev: string | null }; let old: UnitParams | null = null; try { old = row.prev ? JSON.parse(row.prev) : this.lastRead; } catch { old = this.lastRead; } if (!old) throw new HttpError(409, "there are no kept values to go back to"); if (this.inflight > 0) throw new HttpError(409, "a command is still being sent");
    this.inflight++; try { const bad: string[] = []; for (const reg of [REG.RADIO, REG.MODE, REG.ACK, REG.RETRY_MS, REG.OPTIONS, REG.LOCAL_GROUP, REG.LOCAL_ADDR, REG.DEST_GROUP, REG.DEST_ADDR, REG.PACKET_LEN, REG.PACK_TIME]) { const hex = old.raw[reg]; if (!hex) continue; try { await this.link.writeReg(reg, Buffer.from(hex, "hex")); } catch { bad.push("0x" + reg.toString(16)); } }
      audit(this.db, a.username, a.role, "a100.revert", { failed: bad }); return { ok: bad.length === 0, failed: bad };
    } finally { this.inflight--; }
  }
  private plan(old: UnitParams, ch: Record<string, unknown>, confirmRemote: boolean) {
    const out: { name: string; reg: number; data: Buffer; before: unknown; after: unknown }[] = []; const has = (k: string) => ch[k] !== undefined && ch[k] !== null && ch[k] !== "";
    const reg16 = (reg: number) => Buffer.from(old.raw[reg] ?? "0000", "hex").readUInt16BE(0), reg8 = (reg: number) => Buffer.from(old.raw[reg] ?? "00", "hex")[0];
    if (has("channel") || has("powerDbm") || has("airKbps")) {
      const r = decodeRadio(reg16(REG.RADIO)), next = { channel: has("channel") ? int(ch.channel, 0, MAX_CHANNEL, "channel") : r.channel, powerDbm: has("powerDbm") ? Number(ch.powerDbm) : r.powerDbm, airKbps: has("airKbps") ? Number(ch.airKbps) : r.airKbps };
      if (!(POWER_DBM as readonly number[]).includes(next.powerDbm)) throw new HttpError(400, "power must be 21, 24, 27 or 30 dBm"); if (!(AIR_KBPS as readonly number[]).includes(next.airKbps)) throw new HttpError(400, "air rate must be one of " + AIR_KBPS.join(", ") + " kbps");
      let v: number; try { v = encodeRadio(next); } catch (e) { throw new HttpError(400, (e as Error).message); } if (v !== reg16(REG.RADIO)) { const b = Buffer.alloc(2); b.writeUInt16BE(v); out.push({ name: "radio", reg: REG.RADIO, data: b, before: r, after: next }); }
    }
    const u16 = (name: string, reg: number, v: number, before: unknown, after: unknown) => { if (v !== reg16(reg)) { const b = Buffer.alloc(2); b.writeUInt16BE(v); out.push({ name, reg, data: b, before, after }); } };
    const u8 = (name: string, reg: number, v: number, before: unknown, after: unknown) => { if (v !== reg8(reg)) out.push({ name, reg, data: Buffer.from([v]), before, after }); };
    if (has("mode")) { const m = int(ch.mode, 0, 0xffff, "mode"); if (!OFFERED_MODES.includes(m)) throw new HttpError(400, "mode must be transparent (1), target transmission (2) or master-slave (4)"); u16("mode", REG.MODE, m, reg16(REG.MODE), m); }
    if (has("ackEnabled") || has("ackRetries")) { const o = decodeAck(reg8(REG.ACK)), n = { enabled: has("ackEnabled") ? !!ch.ackEnabled : o.enabled, retries: has("ackRetries") ? int(ch.ackRetries, 0, 127, "retransmissions") : o.retries }; u8("radio ack", REG.ACK, encodeAck(n), o, n); }
    if (has("retryMs")) u16("retry interval", REG.RETRY_MS, int(ch.retryMs, 0, 65535, "retry interval"), reg16(REG.RETRY_MS), ch.retryMs);
    for (const [k, reg, nm] of [["localGroup", REG.LOCAL_GROUP, "local group"], ["localAddress", REG.LOCAL_ADDR, "local address"], ["destGroup", REG.DEST_GROUP, "destination group"], ["destAddress", REG.DEST_ADDR, "destination address"]] as const) if (has(k)) u8(nm, reg, int(ch[k], 0, 255, nm), reg8(reg), ch[k]);
    if (has("packetLen")) u8("packet length", REG.PACKET_LEN, int(ch.packetLen, 1, 230, "packet length"), reg8(REG.PACKET_LEN), ch.packetLen);
    if (has("packTimeMs")) u16("packing time", REG.PACK_TIME, Math.round(int(ch.packTimeMs, 1, 25, "packing time (ms)") * 10), reg16(REG.PACK_TIME) / 10, ch.packTimeMs);      // register 0x0F is 2 bytes, in 0.1 ms
    if (has("remoteConfig")) { const cur = reg16(REG.OPTIONS), want = !!ch.remoteConfig; if (((cur >> 4) & 1) === (want ? 1 : 0)) { /* no change */ } else { if (!confirmRemote) throw new HttpError(400, "changing remote configuration needs its own confirmation (confirmRemote): it lets other modules in range reconfigure the unit"); u16("options", REG.OPTIONS, setOption(cur, "remoteConfig", want), { remoteConfig: !want }, { remoteConfig: want }); } }
    if (has("baud")) { const n = int(ch.baud, 0, 1_000_000, "baud"); if (!(BAUDS as readonly number[]).includes(n)) throw new HttpError(400, "baud must be one of " + BAUDS.join(", ")); const b = encodeBaud(n); if (!b.equals(Buffer.from(old.raw[REG.BAUD] ?? "", "hex"))) out.push({ name: "serial baud", reg: REG.BAUD, data: b, before: old.baud, after: n }); }
    if (ch.format && typeof ch.format === "object") { const f = { ...(old.format ?? { dataBits: 8, stopBits: 1, parity: "none" }), ...(ch.format as object) } as any; const v = encodeFormat(f); if (v !== reg8(REG.FORMAT)) out.push({ name: "serial format", reg: REG.FORMAT, data: Buffer.from([v]), before: old.format, after: decodeFormat(v) }); }
    return out;
  }
  /** SET NEW KEY: 16 ASCII characters, written to register 0x0B and forgotten. The key is not stored, logged, audited or returned. */
  async setKey(a: Actor, body: Record<string, unknown>) {
    if (body.confirm !== true) throw new HttpError(400, "confirm: the key must be changed on both ends of the link or the radios stop understanding each other");
    const k = body.key; if (typeof k !== "string" || !/^[\x20-\x7e]{16}$/.test(k)) throw new HttpError(400, "the key must be exactly 16 printable characters");
    if (this.inflight > 0) throw new HttpError(409, "a command is still being sent"); this.inflight++;
    try { await this.link.writeReg(REG.KEY, Buffer.from(k, "ascii")); audit(this.db, a.username, a.role, "a100.key.set", { done: true }); if (this.lastRead) { this.lastRead.defaultKey = false; this.db.prepare("UPDATE a100_link SET snapshot=? WHERE id=1").run(JSON.stringify(this.lastRead)); } this.emit("update"); return { ok: true }; }
    catch (e) { throw this.httpOf(e); } finally { this.inflight--; }
  }
  /** Reboot or factory restore. DISABLED (manual check 2026-11-18): the manual's examples echo 0x22 / 0x23 while the register table says 0x20 / 0x21, so it must be verified on a real unit with nothing else on the link
   *  first. The driver already accepts either echo; flip RESET_ENABLED after that check. Each needs its own typed confirmation once enabled. */
  async resetUnit(a: Actor, body: Record<string, unknown>) {
    if (!RESET_ENABLED) throw new HttpError(409, "reboot and factory restore are disabled until they are verified on a real A100 (the manual gives two different register addresses); use the RESET button on the unit or the AS_DS tool");
    const what = body.action === "reboot" ? REG.REBOOT : body.action === "factory" ? REG.FACTORY : null; if (what === null) throw new HttpError(400, "action must be reboot or factory");
    const word = what === REG.REBOOT ? "REBOOT" : "FACTORY"; if (body.confirm !== word) throw new HttpError(400, `type ${word} to confirm`);
    if (this.inflight > 0) throw new HttpError(409, "a command is still being sent"); await this.link.command(what).catch((e) => { throw this.httpOf(e); });
    audit(this.db, a.username, a.role, what === REG.REBOOT ? "a100.reboot" : "a100.factory_restore", {}); if (what === REG.FACTORY) { this.lastRead = null; this.db.prepare("UPDATE a100_link SET snapshot=NULL WHERE id=1").run(); } this.emit("update"); return { ok: true };
  }

  // ---------- devices behind the link ----------
  devices() { return (this.db.prepare("SELECT * FROM a100_devices ORDER BY id").all() as any[]).map((r) => this.devView(r)); }
  private devView(r: any) { const last = this.db.prepare("SELECT status, command, created_at FROM a100_commands WHERE device_id=? ORDER BY created_at DESC LIMIT 1").get(r.id) as any;
    const payloads = JSON.parse(r.payloads || "{}") as Record<string, string>;
    return { id: r.id, name: r.name, kind: r.kind, role: r.role, zoneId: r.zone_id, scope: r.scope, destGroup: r.dest_group, destAddr: r.dest_addr, channel: r.channel, rateLimitS: r.rate_limit_s, enabled: !!r.enabled, commands: Object.keys(payloads),
      state: this.linkAnswering() ? (last ? (last.status === "confirmed" ? "CONFIRMED" : last.status === "sent" ? "SENT" : last.status === "failed" ? "FAILED" : "UNKNOWN") : "UNKNOWN") : "UNKNOWN", lastCommand: last ? { command: last.command, status: last.status, at: last.created_at } : null }; }
  saveDevice(a: Actor, id: number | null, b: Record<string, unknown>) {
    const old = id === null ? null : (this.db.prepare("SELECT * FROM a100_devices WHERE id=?").get(id) as any); if (id !== null && !old) throw new HttpError(404, "device not found");
    const name = String(b.name ?? old?.name ?? "").trim(); if (!name || name.length > 60) throw new HttpError(400, "name must be 1 to 60 characters");
    const kind = String(b.kind ?? old?.kind ?? "fan"); if (!(DEVICE_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "kind must be one of " + DEVICE_KINDS.join(", "));
    const role = b.role === undefined ? old?.role ?? null : b.role === null || b.role === "" ? null : String(b.role).slice(0, 40), zone = b.zone_id === undefined ? old?.zone_id ?? null : b.zone_id === null ? null : int(b.zone_id, 1, 1e9, "zone");
    const scope = String(b.scope ?? old?.scope ?? "site").slice(0, 60);
    const g = int(b.dest_group ?? old?.dest_group ?? 0, 0, 255, "destination group"), ad = int(b.dest_addr ?? old?.dest_addr ?? 0, 0, 255, "destination address"), ch = int(b.channel ?? old?.channel ?? 0, 0, 255, "channel"), rl = int(b.rate_limit_s ?? old?.rate_limit_s ?? 10, 1, 3600, "rate limit (s)");
    let payloads = old?.payloads ?? "{}"; if (b.payloads !== undefined) { const p = b.payloads as Record<string, unknown>; if (!p || typeof p !== "object") throw new HttpError(400, "payloads must be an object"); const clean: Record<string, string> = {}; for (const [k, v] of Object.entries(p)) { if (!/^[a-z0-9_]{1,24}$/.test(k) || typeof v !== "string" || !/^([0-9a-fA-F]{2})+$/.test(v) || v.length > 400) throw new HttpError(400, "each payload is a command name and an even-length hex string"); clean[k] = v.toLowerCase(); } payloads = JSON.stringify(clean); }
    const enabled = b.enabled === undefined ? (old ? !!old.enabled : true) : !!b.enabled;
    if (id === null) { id = Number(this.db.prepare("INSERT INTO a100_devices(name,kind,role,zone_id,scope,dest_group,dest_addr,channel,rate_limit_s,enabled,payloads) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(name, kind, role, zone, scope, g, ad, ch, rl, enabled ? 1 : 0, payloads).lastInsertRowid); audit(this.db, a.username, a.role, "a100.device.add", { id, name, kind, dest: [g, ad, ch] }); }
    else { this.db.prepare("UPDATE a100_devices SET name=?,kind=?,role=?,zone_id=?,scope=?,dest_group=?,dest_addr=?,channel=?,rate_limit_s=?,enabled=?,payloads=? WHERE id=?").run(name, kind, role, zone, scope, g, ad, ch, rl, enabled ? 1 : 0, payloads, id);
      audit(this.db, a.username, a.role, "a100.device.update", { id, old: { name: old.name, dest: [old.dest_group, old.dest_addr, old.channel], rate_limit_s: old.rate_limit_s, enabled: !!old.enabled }, new: { name, dest: [g, ad, ch], rate_limit_s: rl, enabled } }); }
    this.emit("update"); return this.devices().find((d) => d.id === id)!;
  }
  deleteDevice(a: Actor, id: number) { const r = this.db.prepare("SELECT name FROM a100_devices WHERE id=?").get(id) as any; if (!r) throw new HttpError(404, "device not found"); this.db.prepare("DELETE FROM a100_devices WHERE id=?").run(id); audit(this.db, a.username, a.role, "a100.device.remove", { id, name: r.name }); this.emit("update"); return { ok: true }; }

  // ---------- commands ----------
  commands(limit = 20) { return (this.db.prepare("SELECT c.*, d.name AS device FROM a100_commands c LEFT JOIN a100_devices d ON d.id=c.device_id ORDER BY c.created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({ id: r.id, deviceId: r.device_id, device: r.device, command: r.command, user: r.username, status: r.status.toUpperCase(), note: r.note, at: r.created_at })); }
  /** One command to one device behind the link. Operators and Admin may call this from CONTROL; the A100 page itself stays Admin only. */
  async command(u: Actor, deviceId: number, command: string) {
    const r = this.db.prepare("SELECT * FROM a100_devices WHERE id=?").get(deviceId) as any; if (!r || !r.enabled) throw new HttpError(404, "device not found");
    const payload = (JSON.parse(r.payloads || "{}") as Record<string, string>)[command];
    if (!payload) throw new HttpError(409, "no command payload is set for this device yet (TODO fan-payload: the frame has to come from the Online / EDGE fan link)");
    if (!this.linkAnswering()) throw new HttpError(409, "the A100 link is not answering: the state of this device is UNKNOWN and commands are disabled");
    const last = this.db.prepare("SELECT created_at c FROM a100_commands WHERE device_id=? AND status<>'failed' ORDER BY created_at DESC LIMIT 1").get(deviceId) as { c: number } | undefined, now = this.now();
    if (last && now - last.c < r.rate_limit_s * 1000) throw new HttpError(429, `wait ${Math.ceil((r.rate_limit_s * 1000 - (now - last.c)) / 1000)} s: at most one command every ${r.rate_limit_s} s to this device`);
    const mode = this.lastRead?.mode?.value; if (mode === undefined) throw new HttpError(409, "READ FROM UNIT first so CORE knows the A100 working mode");
    let frame: Buffer; if (mode === 0x0002) frame = Buffer.concat([targetPrefix(r.dest_group, r.dest_addr, r.channel), Buffer.from(payload, "hex")]); else if (mode === 0x0001) frame = Buffer.from(payload, "hex"); else throw new HttpError(409, "the A100 mode (master-slave or other) is not supported for commands yet");
    const id = randomUUID(); this.db.prepare("INSERT INTO a100_commands(id,device_id,command,username,role,status,created_at) VALUES(?,?,?,?,?,'sent',?)").run(id, deviceId, command, u.username, u.role, now);
    audit(this.db, u.username, u.role, "a100.command", { id, device: r.name, command }); this.inflight++;
    try { await this.link.sendData(frame); } catch (e) { this.resolve(id, "failed", (e as Error).message); this.emit("update"); throw new HttpError(502, "the command could not be written to the A100: " + (e as Error).message); } finally { this.inflight--; }
    this.emit("update"); return { id, status: "SENT", note: "Written to the A100. The radio ACK is not reported to CORE, so this is not confirmed." };
  }
  /** SENT -> UNKNOWN after the timeout when no feedback arrived. Called by a timer in index.ts and directly by tests. */
  sweep(now = this.now()) { const rows = this.db.prepare("SELECT id FROM a100_commands WHERE status='sent' AND created_at < ?").all(now - this.unknownAfterMs) as { id: string }[]; for (const r of rows) this.resolve(r.id, "unknown", "no feedback from the receiver side", now); if (rows.length) this.emit("update"); return rows.length; }
  /** TODO(fan-feedback): the only way to CONFIRMED. Nothing calls it until the receiver / VFD feedback protocol is known. */
  confirmFromFeedback(id: string, note = "feedback received") { this.resolve(id, "confirmed", note); this.emit("update"); }
  private resolve(id: string, status: CmdStatus, note: string | null, now = this.now()) { this.db.prepare("UPDATE a100_commands SET status=?, note=?, resolved_at=? WHERE id=? AND status IN ('sent','unknown')").run(status, note, now, id); audit(this.db, "system", "system", `a100.command.${status}`, { id, note }); }

  // ---------- views ----------
  view() {
    const d = this.fanRow(), pm = this.ports(), port = d && pm?.store.port(d.port_id), p = this.lastRead;
    const banner = !d || !port ? "DISABLED" : !d.enabled || !port.enabled ? "DISABLED" : this.linkAnswering() ? "A100 ANSWERING" : this.answeredAt() === null ? "CONNECTING" : "NO ANSWER";
    const ls = port && pm?.queueOf(port.id)?.tr.linkState?.();
    return { banner, link: d ? { portId: d.port_id, enabled: d.enabled } : null, port: port ? { id: port.id, label: port.label, transport: port.transport, baud: port.baud, dataBits: port.data_bits, parity: port.parity, stopBits: port.stop_bits, timeoutMs: port.timeout_ms, retries: port.retries, open: ls?.state === "open" } : null,
      ports: (pm?.store.ports() ?? []).map((x) => ({ id: x.id, label: x.label })), params: p, readAt: (this.db.prepare("SELECT snapshot_at s FROM a100_link WHERE id=1").get() as any).s as number | null, warnings: this.warnings(), devices: this.devices(), commands: this.commands(20),
      resetEnabled: RESET_ENABLED, ranges: { maxChannel: MAX_CHANNEL, airKbps: AIR_KBPS, powerDbm: POWER_DBM, bauds: BAUDS, modes: OFFERED_MODES, regLen: REG_LEN },
      notes: { regulatory: "The unit can transmit up to 30 dBm on 433 MHz by default. Confirm the allowed frequency and power for the site's country before raising power. CORE sets no power or channel by itself.",
        keyStorage: "CORE does not keep the encryption key. SET NEW KEY writes it to the unit and forgets it.", feedback: "SENT means written to the A100. The radio ACK is not reported to CORE. CONFIRMED needs feedback from the receiver or the VFD (not defined yet).", local: "The local hand/auto control on each VFD keeps working independently of CORE." } };
  }
  /** What the CONTROL page gets (Operator included): name, kind, role, scope and a state word. No address, channel, payload or radio value. */
  controlDevices() { return this.devices().filter((d) => d.enabled).map((d) => ({ id: `a100-${d.id}`, linkId: d.id, kind: d.kind, role: d.role, name: d.name, zoneId: d.zoneId, capabilities: [] as string[], link: "a100", linkState: d.state, commands: d.commands })); }
}
