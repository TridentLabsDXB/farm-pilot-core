// Pure logic for the C1 gateway: slot assignment, sync planning, calibration math, staleness, health. No I/O, so every rule is unit-testable.
import type { Group } from "../drivers/modbus/driver.js";

// ---------------- sync planning ----------------
export interface RegSensor { serial: string; slot: number | null; interval: number; sentSlot: number | null; }
export interface PlanWrite { slot: number; serial: string; interval: number; reason: "add" | "interval" | "move" | "replace"; }
export interface PlanClear { slot: number; serial: string; reason: "removed" | "moved"; }
export interface SyncPlan { writes: PlanWrite[]; clears: PlanClear[]; unassigned: Group[]; failures: { serial: string; reason: string }[]; reassigned: { serial: string; from: number | null; to: number }[]; confirm: { kind: string; serial: string; slot: number }[]; }

/** First free slot for a type: not used by a registry sensor, not held by any gateway group (foreign or pending removal), not in `extraTaken`. Lowest index first, stable. */
export function freeSlot(groups: number, taken: Set<number>): number | null { for (let i = 1; i <= groups; i++) if (!taken.has(i)) return i; return null; }

export function planSync(groups: number, sensors: RegSensor[], gateway: Group[], pendingRemovals: { serial: string; slot: number | null }[]): SyncPlan {
  const plan: SyncPlan = { writes: [], clears: [], unassigned: [], failures: [], reassigned: [], confirm: [] };
  const removed = new Set(pendingRemovals.map((r) => r.serial)); const bySerial = new Map(sensors.map((s) => [s.serial, s]));
  const gw = new Map<number, Group>(); for (const g of gateway) if (g.serial) gw.set(g.slot, g);
  const where = new Map<string, number>(); for (const g of gateway) if (g.serial) where.set(g.serial, g.slot);
  // Slots that stay occupied by something we must not overwrite: foreign groups (unknown serial, never auto-added), and registry sensors' own slots.
  const taken = new Set<number>();
  for (const g of gw.values()) if (!bySerial.has(g.serial!) && !removed.has(g.serial!)) { taken.add(g.slot); plan.unassigned.push(g); }
  for (const s of sensors) if (s.slot !== null) taken.add(s.slot);
  for (const r of pendingRemovals) if (r.slot !== null) taken.add(r.slot);   // not silently reused: a removed sensor's slot is only freed by a confirmed Send
  const used = new Set<number>();                                             // slots this plan writes
  for (const s of sensors) {
    let slot = s.slot;
    const occ = slot !== null ? gw.get(slot) : undefined;
    const foreign = occ && occ.serial !== s.serial && !removed.has(occ.serial!);
    if (slot === null || foreign) {
      const nt = new Set(taken); for (const g of gw.values()) nt.add(g.slot);          // for a (re)assignment avoid everything physically in the gateway
      const f = freeSlot(groups, nt); if (f === null) { plan.failures.push({ serial: s.serial, reason: "type full" }); continue; }
      plan.reassigned.push({ serial: s.serial, from: slot, to: f }); slot = f; taken.add(f);
    }
    const here = gw.get(slot);
    const at = where.get(s.serial);
    if (here && here.serial === s.serial) { if (here.interval !== s.interval) plan.writes.push({ slot, serial: s.serial, interval: s.interval, reason: "interval" }); used.add(slot); continue; }
    if (at !== undefined && at !== slot) { plan.writes.push({ slot, serial: s.serial, interval: s.interval, reason: "move" }); plan.clears.push({ slot: at, serial: s.serial, reason: "moved" }); plan.confirm.push({ kind: "moved", serial: s.serial, slot: at }); used.add(slot); continue; }
    if (here && here.serial && removed.has(here.serial)) { plan.writes.push({ slot, serial: s.serial, interval: s.interval, reason: "replace" }); plan.confirm.push({ kind: "replaced", serial: here.serial, slot }); used.add(slot); continue; }
    plan.writes.push({ slot, serial: s.serial, interval: s.interval, reason: "add" }); used.add(slot);
  }
  for (const r of pendingRemovals) {
    const slot = where.get(r.serial); if (slot === undefined || used.has(slot)) continue;
    plan.clears.push({ slot, serial: r.serial, reason: "removed" }); plan.confirm.push({ kind: "removed", serial: r.serial, slot });
  }
  plan.writes.sort((a, b) => a.slot - b.slot); plan.clears.sort((a, b) => a.slot - b.slot);
  return plan;
}

// ---------------- calibration ----------------
export interface Cal { offset: number; gain: number; }
export const applyCal = (raw: number, c: Cal | undefined) => (c ? Math.round((raw * c.gain + c.offset) * 1000) / 1000 : raw);
export interface Limits { maxOffset: number; gainMin: number; gainMax: number; }
export const DEFAULT_LIMITS: Record<string, Limits> = { temperature: { maxOffset: 5, gainMin: 0.8, gainMax: 1.2 }, humidity: { maxOffset: 15, gainMin: 0.8, gainMax: 1.2 } };
export const offsetCal = (raw: number, reference: number): Cal => ({ offset: Math.round((reference - raw) * 1000) / 1000, gain: 1 });
export function twoPointCal(raw1: number, ref1: number, raw2: number, ref2: number): Cal {
  if (Math.abs(raw2 - raw1) < 1e-9) throw new Error("the two raw readings must differ");
  const gain = (ref2 - ref1) / (raw2 - raw1); return { gain: Math.round(gain * 10000) / 10000, offset: Math.round((ref1 - gain * raw1) * 1000) / 1000 };
}
/** Returns the list of limit violations (empty = inside the limits). */
export function checkLimits(c: Cal, l: Limits): string[] {
  const v: string[] = []; if (Math.abs(c.offset) > l.maxOffset) v.push(`offset ${c.offset} is outside +/-${l.maxOffset}`); if (c.gain < l.gainMin || c.gain > l.gainMax) v.push(`gain ${c.gain} is outside ${l.gainMin}..${l.gainMax}`); return v;
}

// ---------------- staleness (replaceable) ----------------
export interface FrameObs { regs: number[]; allZero: boolean; }
export interface StaleState { fp: string | null; lastChange: number | null; }
export type Liveness = "ok" | "no_update" | "no_data";
export interface StalenessDetector { liveness(s: StaleState, now: number, intervalSec: number): Liveness; evaluate(prev: StaleState, obs: FrameObs, now: number, intervalSec: number): { state: StaleState; liveness: Liveness; changed: boolean }; }
/** Default rule: fingerprint of the WHOLE channel frame (values + voltage + RSSI). Identical for N intervals => "no update". All-zero => "no data". Heuristic until validated on hardware. */
export class FingerprintDetector implements StalenessDetector {
  constructor(public multiplier = 3) {}
  liveness(s: StaleState, now: number, intervalSec: number): Liveness {
    if (s.fp === null || s.lastChange === null) return "no_data";
    return now - s.lastChange > this.multiplier * intervalSec * 1000 ? "no_update" : "ok";
  }
  evaluate(prev: StaleState, obs: FrameObs, now: number, intervalSec: number) {
    if (obs.allZero) return { state: { fp: null, lastChange: prev.lastChange }, liveness: "no_data" as Liveness, changed: false };
    const fp = obs.regs.join(","); const changed = fp !== prev.fp; const lastChange = changed || prev.lastChange === null ? now : prev.lastChange;
    const state = { fp, lastChange }; return { state, liveness: this.liveness(state, now, intervalSec), changed };
  }
}
export const offlineAfterMs = (intervalSec: number, multiplier: number) => intervalSec * multiplier * 1000;
/** Modbus poll period: default (30 s) but never longer than half the shortest sensor interval in use, floor 10 s. */
export const pollPeriodMs = (shortestIntervalSec: number | null, defaultSec = 30) => Math.max(10, Math.min(defaultSec, shortestIntervalSec ? shortestIntervalSec / 2 : defaultSec)) * 1000;

// ---------------- health ----------------
export type Status = "ok" | "no_update" | "no_data" | "low_battery" | "unknown" | "not_sent";
export const rssiBand = (dbm: number | undefined, good: number, poor: number): "good" | "weak" | "poor" | "none" => (dbm === undefined ? "none" : dbm > good ? "good" : dbm >= poor ? "weak" : "poor");
export function sensorStatus(o: { gatewayOnline: boolean; sent: boolean; liveness: Liveness | null; voltage?: number; lowVoltage: number }): Status {
  if (!o.gatewayOnline) return "unknown"; if (!o.sent) return "not_sent";
  if (o.liveness === "no_update") return "no_update"; if (o.liveness === "no_data" || o.liveness === null) return "no_data";
  if (o.voltage !== undefined && o.voltage > 0 && o.voltage < o.lowVoltage) return "low_battery"; return "ok";
}
