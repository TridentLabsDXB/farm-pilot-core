// HTTP-level tests of the gateway API (Fastify inject): the interval rule and the factory-reset confirmation.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import Fastify from "fastify"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { config } from "../src/config.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { registerGatewayRoutes } from "../src/gateway/routes.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
async function rig() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); closers.push(() => { void tr.close(); srv.close(); });
  const reg = new Registry(db, map); const svc = new GatewayService(db, reg, new Ingest(db), new GatewayDriver(new ModbusMaster(tr, { unit: 1, timeoutMs: 150, retries: 0 }), map));
  const app = Fastify(); app.decorateRequest("user", undefined as any);
  app.addHook("onRequest", async (req) => { (req as any).user = { id: 1, username: "admin", role: "admin" }; });
  registerGatewayRoutes(app, db, reg, svc, async () => {}, () => {}); await app.ready(); closers.push(() => void app.close());
  await svc.pollNow(); const call = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: payload as any }); return { status: r.statusCode, body: r.json() as any }; };
  return { db, sim, reg, svc, call };
}
const SER = "4A01B3F2";

test("interval rule: 1 min and 5 min always; 10 s, 45 s, 600 s, custom values never; 30 s only in commissioning mode", async () => {
  const { call, db } = await rig(); assert.equal((await call("POST", "/api/sensors", { type: "th", serials: [SER] })).status, 200);
  for (const ok of [60, 300]) assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: ok })).status, 200, `${ok} s must be accepted`);
  for (const bad of [10, 15, 29, 31, 45, 90, 120, 600, 3600, 0, -60, 60.5]) { const r = await call("PATCH", `/api/sensors/${SER}`, { interval: bad }); assert.equal(r.status, 400, `${bad} must be rejected`); assert.match(r.body.error, /interval must be one of: 1 min, 5 min/); }
  const r30 = await call("PATCH", `/api/sensors/${SER}`, { interval: 30 }); assert.equal(r30.status, 400); assert.match(r30.body.error, /30 s needs commissioning mode/);
  assert.equal((await call("PUT", "/api/gateway/settings", { commissioning: true })).status, 200);
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: 30 })).status, 200);
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: 10 })).status, 400, "10 s is never allowed, not even in commissioning mode");
  assert.deepEqual((await call("GET", "/api/sensors")).body.types[0].presets, [30, 60, 300]);
  assert.equal((await call("PUT", "/api/gateway/settings", { commissioning: false })).status, 200); assert.deepEqual((await call("GET", "/api/sensors")).body.types[0].presets, [60, 300]);
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: 30 })).status, 400);
  assert.equal((await call("PUT", "/api/gateway/settings", { commissioning: "yes" })).status, 400);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='gateway.settings'").get() as any).c >= 2, true);                       // turning the option on/off is audited
  assert.equal(db.prepare("SELECT reporting_interval v FROM sensors").get()!.v, 30);                                                            // rejected calls changed nothing
});
test("an already stored non-standard value stays displayable and is flagged; other edits still work", async () => {
  const { call, db } = await rig(); await call("POST", "/api/sensors", { type: "th", serials: [SER] });
  db.prepare("UPDATE sensors SET reporting_interval=10").run();                                                                                   // as written by older builds / a restored backup
  let s = (await call("GET", "/api/sensors")).body.sensors[0]; assert.equal(s.intervalSec, 10); assert.equal(s.intervalOk, false);
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { label: "Row 1" })).status, 200);                                                    // editing the label does not touch the interval rule
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: 60 })).status, 200); s = (await call("GET", "/api/sensors")).body.sensors[0]; assert.equal(s.intervalOk, true);
});
test("Delete all sensors in gateway: wrong or missing confirmation does nothing and is audited; the farm name runs it and writes request + result audit rows", async () => {
  const { call, db, sim } = await rig(); await call("POST", "/api/sensors", { type: "th", serials: [SER] }); assert.equal((await call("POST", "/api/gateway/sync", { types: ["th"] })).status, 200); assert.equal(sim.state().configured.th, 1);
  for (const body of [undefined, {}, { confirmText: "DELETE ALL" }, { confirmText: config.farm.toUpperCase() + "x" }]) { const r = await call("POST", "/api/gateway/delete-all", body); assert.equal(r.status, 400); }
  assert.equal(sim.state().configured.th, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='gateway.delete_all.refused'").get() as any).c, 4);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused'").get() as any).c, 0);
  assert.equal((await call("POST", "/api/gateway/delete-all", { confirmText: config.farm })).status, 200); assert.equal(sim.state().configured.th, 0);
  const rows = db.prepare("SELECT action,username,detail FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused' ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((r) => r.action), ["gateway.delete_all.request", "gateway.delete_all"]); assert.ok(rows.every((r) => r.username === "admin")); assert.equal(JSON.parse(rows[0].detail).sensors_in_gateway, 1);
});
test("Delete all while the gateway is offline: refused with 409, nothing written, no destructive audit row", async () => {
  const { call, sim, svc, db } = await rig(); sim.preconfigure("th", 1, SER, 300); sim.silent = true; for (let i = 0; i < 3; i++) await svc.pollNow(); assert.equal(svc.online, false);
  const r = await call("POST", "/api/gateway/delete-all", { confirmText: config.farm }); assert.equal(r.status, 409); assert.match(r.body.error, /offline/);
  sim.silent = false; assert.equal(sim.state().configured.th, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused'").get() as any).c, 0);
});

test("Add Sensors validation (API): format, case, duplicates, existing, type, capacity, separators; a bad list adds NOTHING", async () => {
  const { call, db } = await rig(); const count = () => (db.prepare("SELECT COUNT(*) c FROM sensors").get() as any).c; const add = (serials: unknown, type = "th") => call("POST", "/api/sensors", { type, serials });
  // accepted: lower case and padding are normalised to the printed upper-case form; separators: newline, CRLF, comma, semicolon, space
  let r = await add(" 4a01b3f2 \r\n4A01B3F3,4A01B3F4;4A01B3F5  4A01B3F6\n"); assert.equal(r.status, 200); assert.deepEqual(r.body.added, ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6"]);
  assert.equal(count(), 5); assert.deepEqual(db.prepare("SELECT serial FROM sensors ORDER BY slot").all().map((x: any) => x.serial), ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6"]);
  // rejected formats, each named in the message
  for (const bad of ["4A01B3F", "4A01B3F22", "4A01B3G2", "0x4A01B3F2", "4A01-B3F2", "ÄÄÄÄÄÄÄÄ"]) { r = await add([bad]); assert.equal(r.status, 400, bad); assert.match(r.body.error, /invalid serial/); }
  assert.equal((await add("")).status, 400); assert.equal((await add([])).status, 400); assert.equal((await add("  \n , ; ")).status, 400);
  // atomic: one bad entry in a list means none are added
  r = await add(["4A01B3F7", "NOPE"]); assert.equal(r.status, 400); assert.equal(count(), 5);
  r = await add(["4A01B3F7", "4a01b3f7"]); assert.equal(r.status, 400); assert.match(r.body.error, /duplicate/); assert.equal(count(), 5);          // duplicate inside the list, case-insensitive
  r = await add(["4A01B3F7", "4a01b3f2"]); assert.equal(r.status, 400); assert.match(r.body.error, /already exists/); assert.equal(count(), 5);      // already in CORE
  // type
  assert.equal((await add(["4A01B3F7"], "nope")).status, 400); r = await add(["4A01B3F7"], "soil"); assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/); assert.equal(count(), 5);
  // capacity: 30 slots
  const more = (n: number, from: number) => Array.from({ length: n }, (_, i) => (0x5000 + from + i).toString(16).toUpperCase().padStart(8, "0"));
  r = await add(more(26, 0)); assert.equal(r.status, 400); assert.match(r.body.error, /full: 5 of 30 slots used, cannot add 26/); assert.equal(count(), 5);
  r = await add(more(25, 0)); assert.equal(r.status, 200); assert.equal(count(), 30); r = await add(more(1, 100)); assert.equal(r.status, 400); assert.match(r.body.error, /full: 30 of 30/); assert.equal(count(), 30);
});
