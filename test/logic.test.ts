import { test } from "node:test"; import assert from "node:assert/strict";
import { planSync, applyCal, offsetCal, twoPointCal, checkLimits, DEFAULT_LIMITS, FingerprintDetector, offlineAfterMs, pollPeriodMs, sensorStatus, rssiBand, type RegSensor } from "../src/gateway/logic.js";
import type { Group } from "../src/drivers/modbus/driver.js";
const empty = (n = 30): Group[] => Array.from({ length: n }, (_, i) => ({ slot: i + 1, serial: null, interval: 0, control: 0 }));   // slots are numbered 1..n
const gw = (...e: [number, string, number][]) => { const g = empty(); for (const [s, serial, i] of e) g[s - 1] = { slot: s, serial, interval: i, control: 0 }; return g; };
const S = (serial: string, slot: number | null, interval = 300, sentSlot: number | null = null): RegSensor => ({ serial, slot, interval, sentSlot });

test("plan: only changed groups are written; unchanged is silent", () => {
  const p = planSync(30, [S("A", 1), S("B", 2, 60), S("C", 3)], gw([1, "A", 300], [2, "B", 300]), []);
  assert.deepEqual(p.writes.map((w) => [w.slot, w.serial, w.reason]), [[2, "B", "interval"], [3, "C", "add"]]); assert.equal(p.clears.length, 0); assert.equal(p.confirm.length, 0);
});
test("plan: removed sensor gets zeros and needs confirmation; unknown gateway group is untouched and listed unassigned", () => {
  const p = planSync(30, [S("A", 1)], gw([1, "A", 300], [2, "GONE", 300], [6, "FOREIGN", 60]), [{ serial: "GONE", slot: 2 }]);
  assert.deepEqual(p.clears, [{ slot: 2, serial: "GONE", reason: "removed" }]); assert.deepEqual(p.confirm.map((c) => c.kind), ["removed"]);
  assert.deepEqual(p.unassigned.map((g) => g.serial), ["FOREIGN"]); assert.ok(!p.clears.some((c) => c.serial === "FOREIGN"));
});
test("plan: new sensor never takes a slot held by a foreign group or a pending removal", () => {
  const p = planSync(30, [S("N", null)], gw([1, "FOREIGN", 60]), [{ serial: "OLD", slot: 2 }]);
  assert.equal(p.writes[0].slot, 3);
});
test("plan: slot of a sensor collided with a foreign group is reassigned, reported", () => {
  const p = planSync(30, [S("N", 1)], gw([1, "FOREIGN", 60]), []); assert.deepEqual(p.reassigned, [{ serial: "N", from: 1, to: 2 }]); assert.equal(p.writes[0].slot, 2);
});
test("plan: replace overwrites the removed serial's slot and needs confirmation", () => {
  const p = planSync(30, [S("NEW", 4)], gw([4, "OLD", 300]), [{ serial: "OLD", slot: 4 }]);
  assert.deepEqual(p.writes.map((w) => w.reason), ["replace"]); assert.equal(p.clears.length, 0); assert.deepEqual(p.confirm.map((c) => c.kind), ["replaced"]);
});
test("plan: moved sensor writes new slot, clears old, confirmation", () => {
  const p = planSync(30, [S("A", 5)], gw([1, "A", 300]), []); assert.deepEqual(p.clears.map((c) => c.slot), [1]); assert.deepEqual(p.confirm.map((c) => c.kind), ["moved"]);
});
test("plan: type full is reported per serial", () => {
  const sensors = Array.from({ length: 4 }, (_, i) => S("X" + i, null)); const p = planSync(3, sensors, empty(3), []);
  assert.equal(p.writes.length, 3); assert.deepEqual(p.failures, [{ serial: "X3", reason: "type full" }]); assert.deepEqual(p.writes.map((w) => w.slot), [1, 2, 3]);
});
test("calibration: offset, two point, reset (identity), limits", () => {
  const c = offsetCal(23.4, 22.9); assert.deepEqual(c, { offset: -0.5, gain: 1 }); assert.equal(applyCal(23.4, c), 22.9); assert.equal(applyCal(23.4, undefined), 23.4);
  const t = twoPointCal(33, 32.5, 75, 75.5); assert.ok(Math.abs(applyCal(33, t) - 32.5) < 0.01 && Math.abs(applyCal(75, t) - 75.5) < 0.01);
  assert.throws(() => twoPointCal(50, 1, 50, 2));
  assert.deepEqual(checkLimits({ offset: 1, gain: 1 }, DEFAULT_LIMITS.temperature), []); assert.equal(checkLimits({ offset: 6, gain: 1 }, DEFAULT_LIMITS.temperature).length, 1);
  assert.equal(checkLimits({ offset: 0, gain: 1.3 }, DEFAULT_LIMITS.humidity).length, 1); assert.equal(checkLimits({ offset: 16, gain: 0.5 }, DEFAULT_LIMITS.humidity).length, 2);
});
test("staleness: identical frame for 3 intervals -> no_update; any register change resets; zeros -> no_data", () => {
  const d = new FingerprintDetector(3); let st = { fp: null as string | null, lastChange: null as number | null }; const T = 300_000;
  const run = (regs: number[], now: number) => { const r = d.evaluate(st, { regs, allZero: regs.every((x) => !x) }, now, 300); st = r.state; return r; };
  assert.equal(run([235, 580, 360, 65456], 0).liveness, "ok");
  assert.equal(run([235, 580, 360, 65456], 2 * T).liveness, "ok"); assert.equal(run([235, 580, 360, 65456], 3 * T).liveness, "ok");
  assert.equal(run([235, 580, 360, 65456], 3 * T + 1000).liveness, "no_update");
  assert.equal(run([235, 580, 360, 65455], 3 * T + 2000).liveness, "ok");          // only RSSI moved: still a live sensor
  assert.equal(run([0, 0, 0, 0], 4 * T).liveness, "no_data");
});
test("offline threshold follows the per-sensor interval; poll period rule", () => {
  assert.equal(offlineAfterMs(300, 3), 900_000); assert.equal(offlineAfterMs(30, 3), 90_000);
  assert.equal(pollPeriodMs(null), 30_000); assert.equal(pollPeriodMs(300), 30_000); assert.equal(pollPeriodMs(30), 15_000); assert.equal(pollPeriodMs(10), 10_000);
});
test("status: gateway offline means unknown, not individual faults; battery; rssi bands", () => {
  const base = { gatewayOnline: true, sent: true, liveness: "ok" as const, voltage: 3.5, lowVoltage: 3.2 };
  assert.equal(sensorStatus({ ...base, gatewayOnline: false, liveness: "no_update" }), "unknown"); assert.equal(sensorStatus({ ...base, voltage: 3.1 }), "low_battery");
  assert.equal(sensorStatus({ ...base, liveness: "no_update", voltage: 3.1 }), "no_update"); assert.equal(sensorStatus({ ...base, sent: false }), "not_sent");
  assert.deepEqual([-80, -95, -110, undefined].map((v) => rssiBand(v, -90, -105)), ["good", "weak", "poor", "none"]);
});
