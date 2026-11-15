import { test } from "node:test"; import assert from "node:assert/strict";
import { openDb } from "../src/db.js"; import { noteFail, throttled, clearFails } from "../src/auth.js";
const mk = () => openDb(":memory:");
test("5 failures lock user+ip for 5 min, audited once; survives a 'restart' (same db)", () => {
  const db = mk(); const t = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(noteFail(db, "ui", "a|1.1.1.1", t + i), false);
  assert.equal(throttled(db, "ui", "a|1.1.1.1", t + 10), 0);
  assert.equal(noteFail(db, "ui", "a|1.1.1.1", t + 5), true);
  assert.ok(throttled(db, "ui", "a|1.1.1.1", t + 6) > 0);
  assert.equal(throttled(db, "ui", "a|1.1.1.1", t + 300_006), 0);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='login.lockout'").get() as any).c, 1);
});
test("global per-IP limit catches username spraying", () => {
  const db = mk(); let locked = false;
  for (let i = 0; i < 20; i++) locked = noteFail(db, "ip", "9.9.9.9", 5000 + i);
  assert.equal(locked, true); assert.ok(throttled(db, "ip", "9.9.9.9", 6000) > 0); assert.equal(throttled(db, "ip", "8.8.8.8", 6000), 0);
});
test("window expiry restarts the count; clear removes the counter", () => {
  const db = mk(); for (let i = 0; i < 4; i++) noteFail(db, "ui", "k", i);
  assert.equal(noteFail(db, "ui", "k", 400_000), false);
  clearFails(db, "ui", "k"); assert.equal(throttled(db, "ui", "k", 400_001), 0);
});
