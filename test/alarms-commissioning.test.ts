import { readFileSync } from "node:fs";
import { test } from "node:test"; import assert from "node:assert/strict";
import { openDb } from "../src/db.js"; import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { Registry, COMMISSIONING_MS, HttpError } from "../src/gateway/registry.js"; import { AlarmTracker } from "../src/gateway/alarms.js"; import type { Alarm } from "../src/gateway/health.js";
const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" };
const noUp = (serial: string): Alarm => ({ kind: "no_update", severity: "alarm", text: `${serial}: no update`, serial }); const gwOff: Alarm = { kind: "gateway_offline", severity: "alarm", text: "Gateway offline" };

test("alarm events: raised once, cleared when gone, re-raised as a new episode; no duplicates while it stays active", () => {
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any);
  t.sync([noUp("S1")], 1000); t.sync([noUp("S1")], 2000); t.sync([noUp("S1"), gwOff], 3000);
  let h = t.history(50, true); assert.equal(h.length, 2); assert.equal(h.every((r) => r.cleared_at === null), true); assert.equal(h.find((r) => r.kind === "no_update")!.raised_at, 1000);
  t.sync([gwOff], 4000); h = t.history(50, true); assert.equal(h.find((r) => r.kind === "no_update")!.cleared_at, 4000); assert.equal(h.find((r) => r.kind === "gateway_offline")!.cleared_at, null);
  t.sync([gwOff, noUp("S1")], 5000); assert.equal(t.history(50, true).filter((r) => r.kind === "no_update").length, 2);       // second episode of the same alarm
  assert.equal(t.history(50, true)[0].cleared_at, null);                                                                         // open ones first
});
test("acknowledge records who and when once, is audited, survives clearing; Operators never see the source serial", () => {
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any); t.sync([noUp("112600310")], 1000);
  const id = t.history(1, true)[0].id; t.ack({ username: "op1", role: "operator" }, id, 1500); t.ack({ username: "admin", role: "admin" }, id, 1600);      // second ack keeps the first
  t.sync([], 2000); const r = t.history(5, true)[0]; assert.deepEqual([r.acked_by, r.acked_at, r.cleared_at], ["op1", 1500, 2000]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='alarm.ack'").get() as any).c, 1);
  assert.equal(t.history(5, false)[0].source, ""); assert.equal(t.history(5, true)[0].source, "112600310"); assert.throws(() => t.ack(A, 999), HttpError);
});
test("commissioning mode switches itself off after 8 hours and the switch-off is audited", () => {
  const db = openDb(":memory:"); const m2 = structuredClone(map); m2.types.th.commissioning_presets = [1];   // the shipped T/H map has none; the mechanism is kept for a type that does
  const reg = new Registry(db, m2); let now = 1_000_000; reg.now = () => now; reg.add(A, "th", ["112600310"]);
  assert.equal(reg.settings().commissioning, false); assert.throws(() => reg.update(A, "112600310", { interval: 1 }), HttpError);
  reg.saveSettings(A, { commissioning: true }); assert.deepEqual([reg.settings().commissioning, reg.settings().commissioningUntil], [true, 1_000_000 + COMMISSIONING_MS]);
  reg.update(A, "112600310", { interval: 1 });                                                                                      // allowed while on
  now += COMMISSIONING_MS - 1000; assert.equal(reg.settings().commissioning, true);
  now += 1000; assert.equal(reg.settings().commissioning, false); assert.deepEqual(reg.allowedIntervals("th"), [5, 10, 15, 30]); assert.throws(() => reg.update(A, "112600310", { interval: 1 }), HttpError);
  const a = db.prepare("SELECT username,role,detail FROM audit_log WHERE action='gateway.commissioning.auto_off'").all() as any[]; assert.equal(a.length, 1); assert.equal(a[0].username, "system");
  reg.settings(); assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='gateway.commissioning.auto_off'").get() as any).c, 1);                 // audited once only
  reg.saveSettings(A, { commissioning: true }); now += 3600_000; reg.saveSettings(A, { commissioning: false }); assert.equal(reg.settings().commissioning, false);
  reg.saveSettings(A, { commissioning: true }); assert.equal(reg.settings().commissioningUntil, now + COMMISSIONING_MS);                                          // a fresh 8 hours from the new switch-on
});

import type { SyncContext } from "../src/gateway/alarms.js";
const world = (online: boolean, sensors: Record<string, { status: string; calDue?: boolean; lastChange?: number | null }>): SyncContext => ({ gatewayOnline: online, sensor: (s) => (sensors[s] ? { status: sensors[s].status, calDue: !!sensors[s].calDue, lastChange: sensors[s].lastChange ?? null } : null) });
const row = (db: any, kind: string) => db.prepare("SELECT * FROM alarm_events WHERE kind=? ORDER BY id DESC").get(kind) as any;

test("freeze: while the gateway is offline sensor alarms are neither raised nor cleared; open ones stay open and are reported unknown", () => {
  const db = openDb(":memory:"); const svc = { enabled: true, online: true } as any; const t = new AlarmTracker(db, null as any, svc);
  t.sync([noUp("S1")], 1000, world(true, { S1: { status: "no_update", lastChange: 400 } }));
  svc.online = false; t.sync([gwOff], 2000, world(false, { S1: { status: "ok" } }));                       // sensor looks fine in stale data, gateway is offline: must NOT clear
  let h = t.history(10, true); assert.equal(h.find((r) => r.kind === "no_update")!.cleared_at, null); assert.equal(h.find((r) => r.kind === "no_update")!.unknown, true); assert.equal(h.find((r) => r.kind === "gateway_offline")!.unknown, false);
  t.sync([gwOff, { kind: "low_battery", severity: "warning", text: "x", serial: "S2" }], 2500, world(false, { S1: { status: "no_update" }, S2: { status: "low_battery" } }));      // a sensor alarm computed from stale data is not raised either
  assert.equal(h.length, 2); assert.equal(t.history(10, true).length, 2);
  svc.online = true; t.sync([noUp("S1")], 3000, world(true, { S1: { status: "no_update" } }));               // back online and still silent: the SAME episode continues
  h = t.history(10, true); assert.equal(h.filter((r) => r.kind === "no_update").length, 1); assert.equal(h.find((r) => r.kind === "no_update")!.cleared_at, null); assert.equal(h.find((r) => r.kind === "no_update")!.unknown, false);
  assert.equal(h.find((r) => r.kind === "gateway_offline")!.cleared_at, 3000); assert.equal(h.find((r) => r.kind === "gateway_offline")!.clear_reason, "recovered");
});
test("clear_reason: recovered / sensor_removed / not_sent; NO UPDATE records the time of the sensor's last data", () => {
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any);
  t.sync([noUp("S1"), noUp("S2"), noUp("S3")], 1000, world(true, { S1: { status: "no_update", lastChange: 123 }, S2: { status: "no_update", lastChange: 456 }, S3: { status: "no_update", lastChange: 789 } }));
  assert.deepEqual((db.prepare("SELECT source,last_data_at FROM alarm_events ORDER BY source").all() as any[]).map((r) => [r.source, r.last_data_at]), [["S1", 123], ["S2", 456], ["S3", 789]]);
  t.sync([], 2000, world(true, { S1: { status: "ok" }, S3: { status: "not_sent" } }));                         // S1 is healthy again, S2 was removed, S3 was reset to NOT SENT
  const r = Object.fromEntries((db.prepare("SELECT source,clear_reason FROM alarm_events").all() as any[]).map((x) => [x.source, x.clear_reason])); assert.deepEqual(r, { S1: "recovered", S2: "sensor_removed", S3: "not_sent" });
  t.sync([{ kind: "calibration_due", severity: "warning", text: "c", serial: "S1" }], 3000, world(true, { S1: { status: "ok", calDue: true } })); t.sync([], 4000, world(true, { S1: { status: "ok", calDue: false } }));
  assert.equal(row(db, "calibration_due").clear_reason, "recovered"); assert.equal(row(db, "calibration_due").last_data_at, null);
});
test("a sensor removed while the gateway is offline is cleared as sensor_removed (the alarm would be about nothing)", () => {
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any); t.sync([noUp("S1")], 1000, world(true, { S1: { status: "no_update" } }));
  t.sync([gwOff], 2000, world(false, {})); assert.equal(row(db, "no_update").clear_reason, "sensor_removed");
});

test("2026-11-16 clear reasons have real labels (RESET TO NOT SENT, NO DATA, CONDITION ENDED) and no NO UPDATE alarm is raised while settling after a restart or a gateway sync", () => {
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any);
  const w = (st: string, settling = false): SyncContext => ({ gatewayOnline: true, settling, sensor: () => ({ status: st, calDue: false, lastChange: 0 }) });
  t.sync([noUp("S1")], 1000, w("no_update")); t.sync([], 2000, w("not_sent")); assert.equal(row(db, "no_update").clear_reason, "not_sent");
  t.sync([noUp("S1")], 3000, w("no_update")); t.sync([], 4000, w("no_data")); assert.equal(row(db, "no_update").clear_reason, "no_data");
  t.sync([noUp("S1")], 5000, w("no_update")); t.sync([], 6000, w("unknown")); assert.equal(row(db, "no_update").clear_reason, "ended");
  t.sync([noUp("S1")], 7000, w("no_update")); t.sync([], 8000, w("ok")); assert.equal(row(db, "no_update").clear_reason, "recovered");
  const n = (db.prepare("SELECT COUNT(*) c FROM alarm_events").get() as any).c;
  t.sync([noUp("S1")], 9000, w("no_update", true)); assert.equal((db.prepare("SELECT COUNT(*) c FROM alarm_events").get() as any).c, n, "settling: nothing raised");
  t.sync([noUp("S1")], 10000, w("no_update", false)); assert.equal((db.prepare("SELECT COUNT(*) c FROM alarm_events").get() as any).c, n + 1, "after settling it is raised if still true");
  assert.ok(!/OTHER"/.test(readFileSync("web/src/Alarms.tsx", "utf8")) || /CONDITION ENDED/.test(readFileSync("web/src/Alarms.tsx", "utf8")));
});
