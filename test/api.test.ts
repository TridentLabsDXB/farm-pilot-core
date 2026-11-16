import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
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
  const reg = new Registry(db, map); const svc = new GatewayService(db, reg, new Ingest(db), new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  const app = Fastify(); app.decorateRequest("user", undefined as any);
  app.addHook("onRequest", async (req) => { (req as any).user = { id: 1, username: "admin", role: "admin" }; });
  registerGatewayRoutes(app, db, reg, svc, async () => {}, () => {}); await app.ready(); closers.push(() => void app.close());
  await svc.pollNow(); const call = async (method: string, url: string, payload?: unknown) => { const r = await app.inject({ method: method as any, url, payload: payload as any }); return { status: r.statusCode, body: r.json() as any }; };
  return { db, sim, reg, svc, call };
}
const SER = "112600310";

test("interval rule: whole minutes 5..240 (presets 5, 10, 15, 30 and custom); 30 s, 1 min, 4, 241, fractions never; commissioning mode does not exist for T/H", async () => {
  const { call, db } = await rig(); assert.equal((await call("POST", "/api/sensors", { type: "th", serials: [SER] })).status, 200);
  for (const ok of [5, 10, 15, 30, 45, 240]) assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: ok })).status, 200, `${ok} min must be accepted`);
  for (const bad of [0, 0.5, 1, 4, 5.5, 241, 300, -5, "x"]) { const r = await call("PATCH", `/api/sensors/${SER}`, { interval: bad }); assert.equal(r.status, 400, `${bad} must be rejected`); assert.match(r.body.error, /whole number of minutes from 5 to 240/); }
  assert.deepEqual((await call("GET", "/api/sensors")).body.types[0].presets, [5, 10, 15, 30]);
  assert.equal((await call("PUT", "/api/gateway/settings", { commissioning: true })).status, 400);                                               // no T/H commissioning intervals on this gateway
  assert.equal(db.prepare("SELECT reporting_interval v FROM sensors").get()!.v, 240);                                                            // rejected calls changed nothing
});
test("an already stored out-of-rule value stays displayable and is flagged; other edits still work", async () => {
  const { call, db } = await rig(); await call("POST", "/api/sensors", { type: "th", serials: [SER] });
  db.prepare("UPDATE sensors SET reporting_interval=1").run();                                                                                    // as adopted from a gateway or a restored backup
  let s = (await call("GET", "/api/sensors")).body.sensors[0]; assert.equal(s.interval, 1); assert.equal(s.intervalUnit, "minutes"); assert.equal(s.intervalSec, 60); assert.equal(s.intervalOk, false);
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { label: "Row 1" })).status, 200);                                                    // editing the label does not touch the interval rule
  assert.equal((await call("PATCH", `/api/sensors/${SER}`, { interval: 10 })).status, 200); s = (await call("GET", "/api/sensors")).body.sensors[0]; assert.equal(s.intervalOk, true);
});
test("Delete all sensors in gateway: wrong or missing confirmation does nothing and is audited; the farm name runs it and writes request + result audit rows", async () => {
  const { call, db, sim } = await rig(); await call("POST", "/api/sensors", { type: "th", serials: [SER] }); assert.equal((await call("POST", "/api/gateway/sync", { types: ["th"] })).status, 200); assert.equal(sim.state().configured.th, 1);
  for (const body of [undefined, {}, { confirmText: "DELETE ALL" }, { confirmText: "DEMO FARM" + "x" }]) { const r = await call("POST", "/api/gateway/delete-all", body); assert.equal(r.status, 400); }
  assert.equal(sim.state().configured.th, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='gateway.delete_all.refused'").get() as any).c, 4);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused'").get() as any).c, 0);
  assert.equal((await call("POST", "/api/gateway/delete-all", { confirmText: "Demo Farm" })).status, 200); assert.equal(sim.state().configured.th, 0);
  const rows = db.prepare("SELECT action,username,detail FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused' ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((r) => r.action), ["gateway.delete_all.request", "gateway.delete_all"]); assert.ok(rows.every((r) => r.username === "admin")); assert.equal(JSON.parse(rows[0].detail).sensors_in_gateway, 1);
});
test("Delete all while the gateway is offline: refused with 409, nothing written, no destructive audit row", async () => {
  const { call, sim, svc, db } = await rig(); sim.preconfigure("th", 1, SER, 5); sim.silent = true; for (let i = 0; i < 3; i++) await svc.pollNow(); assert.equal(svc.online, false);
  const r = await call("POST", "/api/gateway/delete-all", { confirmText: "Demo Farm" }); assert.equal(r.status, 409); assert.match(r.body.error, /offline/);
  sim.silent = false; assert.equal(sim.state().configured.th, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'gateway.delete_all%' AND action NOT LIKE '%refused'").get() as any).c, 0);
});

test("Add Sensors validation (API): format, case, duplicates, existing, type, capacity, separators; a bad list adds NOTHING", async () => {
  const { call, db } = await rig(); const count = () => (db.prepare("SELECT COUNT(*) c FROM sensors").get() as any).c; const add = (serials: unknown, type = "th") => call("POST", "/api/sensors", { type, serials });
  // accepted: lower case and padding are normalised to the printed upper-case form; separators: newline, CRLF, comma, semicolon, space
  let r = await add(" 112600310 \r\n112600311,112600312;112600313  112600314\n"); assert.equal(r.status, 200); assert.deepEqual(r.body.added, ["112600310", "112600311", "112600312", "112600313", "112600314"]);
  assert.equal(count(), 5); assert.deepEqual(db.prepare("SELECT serial FROM sensors ORDER BY slot").all().map((x: any) => x.serial), ["112600310", "112600311", "112600312", "112600313", "112600314"]);
  // rejected formats, each named in the message
  for (const bad of ["112600", "11260031022", "4A01B3F2", "0x112600310", "1126-00310", "ÄÄÄÄÄÄÄÄ", "0112600310", "4294967295", "4294967296"]) { r = await add([bad]); assert.equal(r.status, 400, bad); assert.match(r.body.error, /invalid serial/); }
  assert.equal((await add("")).status, 400); assert.equal((await add([])).status, 400); assert.equal((await add("  \n , ; ")).status, 400);
  // atomic: one bad entry in a list means none are added
  r = await add(["112600315", "NOPE"]); assert.equal(r.status, 400); assert.equal(count(), 5);
  r = await add(["112600315", "112600315"]); assert.equal(r.status, 400); assert.match(r.body.error, /duplicate/); assert.equal(count(), 5);          // duplicate inside the list, 
  r = await add(["112600315", "112600310"]); assert.equal(r.status, 400); assert.match(r.body.error, /already exists/); assert.equal(count(), 5);      // already in CORE
  // type
  assert.equal((await add(["112600315"], "nope")).status, 400); r = await add(["112600315"], "soil"); assert.equal(r.status, 400); assert.match(r.body.error, /not enabled/); assert.equal(count(), 5);
  // capacity: 30 slots
  const more = (n: number, from: number) => Array.from({ length: n }, (_, i) => String(300000000 + from + i));
  r = await add(more(26, 0)); assert.equal(r.status, 400); assert.match(r.body.error, /full: 5 of 30 slots used, cannot add 26/); assert.equal(count(), 5);
  r = await add(more(25, 0)); assert.equal(r.status, 200); assert.equal(count(), 30); r = await add(more(1, 100)); assert.equal(r.status, 400); assert.match(r.body.error, /full: 30 of 30/); assert.equal(count(), 30);
});
