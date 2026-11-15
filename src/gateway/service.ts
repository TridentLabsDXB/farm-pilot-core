// Gateway runtime: poll loop (backoff, offline detection), reconcile with the gateway's config groups, and the Send to Gateway sync job.
import { EventEmitter } from "node:events";
import { audit, getSetting, setSetting, type Db } from "../db.js";
import { ModbusException } from "../drivers/modbus/frames.js";
import { GatewayDriver, type Group } from "../drivers/modbus/driver.js";
import type { Ingest } from "../ingest.js";
import { applyCal, FingerprintDetector, planSync, pollPeriodMs, type StalenessDetector, type SyncPlan } from "./logic.js";
import { HttpError, topicFor, type Actor, type Registry, type SensorRow } from "./registry.js";

export interface SyncItem { serial: string; slot: number; action: "add" | "interval" | "move" | "replace" | "remove" | "clear"; status: "confirmed" | "failed"; reason?: string; }
export interface SyncResult { type: string; ok: boolean; items: SyncItem[]; at: number; }
const reasonOf = (e: unknown) => (e instanceof ModbusException ? "write rejected" : /timeout/i.test(String((e as Error)?.message)) ? "timeout" : "timeout");

export class GatewayService extends EventEmitter {
  online = false; failCycles = 0; lastOk: number | null = null; lastError: string | null = null; info: { address?: number; version?: number } = {};
  paused = false; syncing = false; lastConfig: Record<string, Group[]> = {};
  private cycle: Promise<void> | null = null; private timer?: NodeJS.Timeout; private n = 0; private stopped = false; private started = false; private obs = new Map<string, number[]>();
  detector: StalenessDetector;
  constructor(private db: Db, private reg: Registry, private ingest: Ingest, public drv: GatewayDriver | null) {
    super(); this.detector = new FingerprintDetector(reg.settings().offlineMultiplier); this.persist();
  }
  get enabled() { return !!this.drv; }

  start() { if (this.drv) { this.started = true; this.schedule(500); } }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.cycle?.catch(() => {}); }
  private period() {
    const st = this.reg.settings(); const iv = this.reg.list().filter((s) => s.sent_slot !== null).map((s) => s.reporting_interval);
    const base = pollPeriodMs(iv.length ? Math.min(...iv) : null, st.pollSec);
    return this.failCycles > 0 ? Math.min(300_000, base * 2 ** Math.min(this.failCycles, 5)) : base;     // backoff while failing
  }
  private schedule(ms: number) { if (this.stopped || !this.started) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.run(), ms); }
  private async run() {
    if (this.paused) return this.schedule(1000);
    this.cycle = this.pollOnce().then(() => this.ok(), (e) => this.fail(e)).finally(() => { this.cycle = null; this.emit("update"); });
    await this.cycle; this.schedule(this.period());
  }
  async pause() { this.paused = true; await this.cycle?.catch(() => {}); }
  resume() { this.paused = false; if (!this.stopped) this.schedule(200); }
  /** Poll right now (used by tests and after a sync). */
  async pollNow(now = Date.now()) { await this.cycle?.catch(() => {}); this.cycle = this.pollOnce(now).then(() => this.ok(), (e) => this.fail(e)).finally(() => { this.cycle = null; this.emit("update"); }); await this.cycle; }

  private ok() { this.failCycles = 0; this.lastError = null; this.lastOk = Date.now(); this.online = true; this.persist(); }
  private fail(e: unknown) {
    this.lastError = String((e as Error)?.message ?? e);
    if (e instanceof ModbusException) { this.persist(); return; }                      // the gateway answered, so it is online; the request itself was wrong
    this.failCycles++; if (this.failCycles >= this.reg.settings().offlineCycles && this.online) { this.online = false; audit(this.db, "system", "system", "gateway.offline", { error: this.lastError }); }
    if (this.failCycles >= this.reg.settings().offlineCycles) this.online = false; this.persist();
  }
  private persist() {
    this.db.prepare(`INSERT INTO gateway_state(id,online,last_ok,version,address,map_version,last_error,updated_at) VALUES(1,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET online=excluded.online,last_ok=excluded.last_ok,version=excluded.version,address=excluded.address,map_version=excluded.map_version,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run(this.online ? 1 : 0, this.lastOk, this.info.version ?? null, this.info.address ?? null, this.reg.map.map_version, this.lastError, Date.now());
  }

  private async pollOnce(now = Date.now()) {
    const drv = this.drv!; const first = this.n++ % 10 === 0;
    if (first) { const s = await drv.readSystem(); this.info = { address: s.address, version: s.version }; for (const t of Object.values(drv.map.types)) if (t.enabled) { this.lastConfig[t.key] = await drv.readConfig(t.key); this.reconcile(t.key); } }
    const cals = this.reg.activeCals(); const all = this.reg.list();
    for (const t of Object.values(drv.map.types)) {
      if (!t.enabled) continue; const sensors = all.filter((s) => s.type === t.key && s.sent_slot !== null); if (!sensors.length) continue;
      const ch = await drv.readData(t.key, Math.max(...sensors.map((s) => s.sent_slot!)));
      for (const s of sensors) { const c = ch[s.sent_slot!]; if (c) this.process(s, c, cals, now); }
    }
  }
  private process(s: SensorRow, c: { regs: number[]; values: Record<string, number>; allZero: boolean }, cals: Map<string, any>, now: number) {
    const r = this.detector.evaluate({ fp: s.fp, lastChange: s.last_change }, { regs: c.regs, allZero: c.allZero }, now, s.reporting_interval);
    if (r.state.fp !== s.fp || r.state.lastChange !== s.last_change) this.db.prepare("UPDATE sensors SET fp=?,last_change=? WHERE serial=?").run(r.state.fp, r.state.lastChange, s.serial);
    if (!r.changed || c.allZero) return;
    const t = this.reg.map.types[s.type], out: Record<string, number> = {};
    for (const [m, f] of Object.entries(t.data.fields)) { const raw = c.values[m]; if (f.calibrated) { out[m + "_raw"] = raw; out[m] = applyCal(raw, cals.get(`${s.serial}|${m}`)); } else out[m] = raw; }
    this.ingest.record(topicFor(s.type), s.serial, out, now);
    if (!s.interval_confirmed) {                                                        // "applying": compare the observed update spacing with the new setting
      const o = (this.obs.get(s.serial) ?? []).concat(now).slice(-3); this.obs.set(s.serial, o);
      if (o.length >= 2) { const sp = o[o.length - 1] - o[o.length - 2], iv = s.reporting_interval * 1000; if (sp >= iv * 0.5 && sp <= iv * 1.6) { this.db.prepare("UPDATE sensors SET interval_confirmed=1 WHERE serial=?").run(s.serial); this.obs.delete(s.serial); } }
    }
  }

  /** The gateway is the truth for what is "sent": sent_slot / sent_interval mirror the last config read-back. */
  reconcile(type: string) {
    const g = this.lastConfig[type]; if (!g) return; const where = new Map<string, Group>(); for (const x of g) if (x.serial) where.set(x.serial, x);
    this.db.transaction(() => {
      for (const s of this.reg.all().filter((x) => x.type === type && !x.replaced_by)) { const h = where.get(s.serial); this.db.prepare("UPDATE sensors SET sent_slot=?,sent_interval=? WHERE serial=?").run(h ? h.slot : null, h ? h.interval : null, s.serial); }
      for (const r of this.db.prepare("SELECT serial FROM pending_removals WHERE type=?").all(type) as { serial: string }[]) if (!where.has(r.serial)) this.db.prepare("DELETE FROM pending_removals WHERE type=? AND serial=?").run(type, r.serial);
    })();
  }
  ignored(): string[] { try { return JSON.parse(getSetting(this.db, "gw.ignored", "[]")); } catch { return []; } }
  ignore(a: Actor, serial: string) { setSetting(this.db, "gw.ignored", JSON.stringify([...new Set([...this.ignored(), serial])])); audit(this.db, a.username, a.role, "gateway.unassigned.ignore", { serial }); }
  /** Groups configured in the gateway whose serial CORE does not know. Never auto-added. */
  unassigned() {
    const known = new Set(this.reg.all().map((s) => s.serial)), ign = new Set(this.ignored()), out: { type: string; slot: number; serial: string; interval: number }[] = [];
    const pend = new Set((this.db.prepare("SELECT serial FROM pending_removals").all() as { serial: string }[]).map((r) => r.serial));
    for (const [type, gs] of Object.entries(this.lastConfig)) for (const g of gs) if (g.serial && !known.has(g.serial) && !ign.has(g.serial) && !pend.has(g.serial)) out.push({ type, slot: g.slot, serial: g.serial, interval: g.interval });
    return out;
  }
  gatewaySlots(type: string) { return (this.lastConfig[type] ?? []).filter((g) => g.serial).map((g) => g.slot); }

  // ---------------- Send to Gateway ----------------
  private requireOnline() { if (!this.drv) throw new HttpError(409, "no gateway configured"); if (!this.online) throw new HttpError(409, "gateway is offline"); if (this.syncing) throw new HttpError(409, "a sync is already running"); }
  private planFor(type: string, gw: Group[]): SyncPlan {
    const t = this.reg.typeDef(type); const sensors = this.reg.list().filter((s) => s.type === type).map((s) => ({ serial: s.serial, slot: s.slot, interval: s.reporting_interval, sentSlot: s.sent_slot }));
    const pend = this.db.prepare("SELECT serial,slot FROM pending_removals WHERE type=?").all(type) as { serial: string; slot: number | null }[];
    return planSync(t.groups, sensors, gw, pend);
  }
  async preview(type: string) { this.requireOnline(); const gw = await this.drv!.readConfig(type, "write"); this.lastConfig[type] = gw; this.reconcile(type); return this.planFor(type, gw); }

  async sync(a: Actor, types: string[], confirm: boolean): Promise<SyncResult[]> {
    this.requireOnline(); this.syncing = true; await this.pause(); const results: SyncResult[] = [];
    try {
      for (const type of types) {
        this.reg.typeDef(type); const done = new Map<string, SyncItem>(); let failures: { serial: string; reason: string }[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          let gw: Group[]; let plan: SyncPlan;
          try { gw = await this.drv!.readConfig(type, "write"); plan = this.planFor(type, gw); }
          catch (e) { if (attempt === 1) { for (const w of this.pendingItems(type)) done.set(w.serial + w.slot, { ...w, status: "failed", reason: reasonOf(e) }); } continue; }
          if (attempt === 0 && plan.confirm.length && !confirm) throw new HttpError(409, "confirmation required: sensors would be removed or moved", { plan });
          for (const r of plan.reassigned) this.db.prepare("UPDATE sensors SET slot=? WHERE serial=?").run(r.to, r.serial);
          failures = plan.failures; const attempted: SyncItem[] = [];
          for (const w of plan.writes) { const it: SyncItem = { serial: w.serial, slot: w.slot, action: w.reason, status: "confirmed" }; attempted.push(it);
            try { await this.drv!.writeGroup(type, w.slot, { serial: w.serial, interval: w.interval }); } catch (e) { it.status = "failed"; it.reason = reasonOf(e); } }
          for (const c of plan.clears) { const it: SyncItem = { serial: c.serial, slot: c.slot, action: c.reason === "removed" ? "remove" : "clear", status: "confirmed" }; attempted.push(it);
            try { await this.drv!.clearGroup(type, c.slot); } catch (e) { it.status = "failed"; it.reason = reasonOf(e); } }
          let back: Group[] | null = null; try { back = await this.drv!.readConfig(type, "write"); } catch { /* every unverified item becomes a timeout below */ }
          for (const it of attempted) {
            if (it.status === "failed") { done.set(it.serial + it.slot + it.action, it); continue; }
            const g = back?.[it.slot]; const w = plan.writes.find((x) => x.slot === it.slot && x.serial === it.serial);
            const okv = !back ? null : w ? g?.serial === w.serial && g.interval === w.interval : g?.serial === null;
            if (okv === null) { it.status = "failed"; it.reason = "timeout"; } else if (!okv) { it.status = "failed"; it.reason = "mismatch"; }
            done.set(it.serial + it.slot + it.action, it);
          }
          if (back) { this.lastConfig[type] = back; this.reconcile(type); }
          const retry = attempted.some((i) => i.status === "failed" && i.reason !== "write rejected"); if (!retry) break;
        }
        const items = [...done.values(), ...failures.map((f) => ({ serial: f.serial, slot: -1, action: "add" as const, status: "failed" as const, reason: f.reason }))];
        for (const it of items) if (it.status === "confirmed" && it.action === "interval") { this.db.prepare("UPDATE sensors SET interval_confirmed=0, interval_changed_at=? WHERE serial=?").run(Date.now(), it.serial); this.obs.delete(it.serial); }
        const res: SyncResult = { type, ok: items.every((i) => i.status === "confirmed"), items, at: Date.now() }; results.push(res);
        this.db.prepare("INSERT INTO sync_runs(ts,username,type,ok,result) VALUES(?,?,?,?,?)").run(res.at, a.username, type, res.ok ? 1 : 0, JSON.stringify(res));
        setSetting(this.db, "gw.last_sync", JSON.stringify(res)); audit(this.db, a.username, a.role, "gateway.sync", { type, ok: res.ok, items: items.map((i) => `${i.action}:${i.serial}:${i.status}${i.reason ? ":" + i.reason : ""}`) });
      }
      return results;
    } finally { this.syncing = false; this.resume(); this.emit("update"); }                  // polling is never left off
  }
  private pendingItems(type: string): SyncItem[] {
    return this.reg.list().filter((s) => s.type === type && (s.sent_slot === null || s.sent_interval !== s.reporting_interval || s.sent_slot !== s.slot)).map((s) => ({ serial: s.serial, slot: s.slot ?? -1, action: "add" as const, status: "failed" as const }));
  }
  lastSync(): SyncResult | null { try { return JSON.parse(getSetting(this.db, "gw.last_sync", "null")); } catch { return null; } }

  /** Factory reset of the gateway: FC06 0x0003 = 0. Callers must have an explicit Admin confirmation. */
  async deleteAll(a: Actor) {
    this.requireOnline(); this.syncing = true; await this.pause();
    try {
      await this.drv!.deleteAll(); audit(this.db, a.username, a.role, "gateway.delete_all", {});
      for (const t of Object.values(this.drv!.map.types)) if (t.enabled) { this.lastConfig[t.key] = await this.drv!.readConfig(t.key, "write"); this.reconcile(t.key); }
      this.db.prepare("DELETE FROM pending_removals").run();
    } finally { this.syncing = false; this.resume(); this.emit("update"); }
  }
}
