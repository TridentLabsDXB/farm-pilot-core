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
  const db = openDb(":memory:"); const t = new AlarmTracker(db, null as any, null as any); t.sync([noUp("4A01B3F2")], 1000);
  const id = t.history(1, true)[0].id; t.ack({ username: "op1", role: "operator" }, id, 1500); t.ack({ username: "admin", role: "admin" }, id, 1600);      // second ack keeps the first
  t.sync([], 2000); const r = t.history(5, true)[0]; assert.deepEqual([r.acked_by, r.acked_at, r.cleared_at], ["op1", 1500, 2000]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='alarm.ack'").get() as any).c, 1);
  assert.equal(t.history(5, false)[0].source, ""); assert.equal(t.history(5, true)[0].source, "4A01B3F2"); assert.throws(() => t.ack(A, 999), HttpError);
});
test("commissioning mode switches itself off after 8 hours and the switch-off is audited", () => {
  const db = openDb(":memory:"); const reg = new Registry(db, map); let now = 1_000_000; reg.now = () => now; reg.add(A, "th", ["4A01B3F2"]);
  assert.equal(reg.settings().commissioning, false); assert.throws(() => reg.update(A, "4A01B3F2", { interval: 30 }), HttpError);
  reg.saveSettings(A, { commissioning: true }); assert.deepEqual([reg.settings().commissioning, reg.settings().commissioningUntil], [true, 1_000_000 + COMMISSIONING_MS]);
  reg.update(A, "4A01B3F2", { interval: 30 });                                                                                      // allowed while on
  now += COMMISSIONING_MS - 1000; assert.equal(reg.settings().commissioning, true);
  now += 1000; assert.equal(reg.settings().commissioning, false); assert.deepEqual(reg.allowedIntervals("th"), [60, 300]); assert.throws(() => reg.update(A, "4A01B3F2", { interval: 30 }), HttpError);
  const a = db.prepare("SELECT username,role,detail FROM audit_log WHERE action='gateway.commissioning.auto_off'").all() as any[]; assert.equal(a.length, 1); assert.equal(a[0].username, "system");
  reg.settings(); assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='gateway.commissioning.auto_off'").get() as any).c, 1);                 // audited once only
  reg.saveSettings(A, { commissioning: true }); now += 3600_000; reg.saveSettings(A, { commissioning: false }); assert.equal(reg.settings().commissioning, false);
  reg.saveSettings(A, { commissioning: true }); assert.equal(reg.settings().commissioningUntil, now + COMMISSIONING_MS);                                          // a fresh 8 hours from the new switch-on
});
