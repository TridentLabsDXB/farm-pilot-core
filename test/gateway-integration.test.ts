import { test, after } from "node:test"; import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry, HttpError } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { buildView } from "../src/gateway/health.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" };
const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const POOL = ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6", "4A01B3F7", "4A01B3F8", "4A01B3F9"];
async function rig() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); closers.push(() => { void tr.close(); srv.close(); });
  const drv = new GatewayDriver(new ModbusMaster(tr, { unit: 1, timeoutMs: 150, retries: 0 }), map); const reg = new Registry(db, map); const svc = new GatewayService(db, reg, new Ingest(db), drv);
  await svc.pollNow(); assert.equal(svc.online, true); return { db, sim, reg, svc };
}
const hist = (db: any, serial: string, metric: string) => db.prepare("SELECT h.value v FROM history_raw h JOIN series s ON s.id=h.series_id WHERE s.sensor_key=? AND s.metric=? ORDER BY h.ts").all(serial, metric).map((r: any) => r.v);

test("8 serials -> Send to Gateway -> all confirmed, IN GATEWAY, then live values flow", async () => {
  const { db, sim, reg, svc } = await rig(); reg.add(A, "th", POOL);
  const plan = await svc.preview("th"); assert.equal(plan.writes.length, 8); assert.equal(plan.confirm.length, 0);
  const [r] = await svc.sync(A, ["th"], false); assert.equal(r.ok, true); assert.equal(r.items.length, 8); assert.ok(r.items.every((i) => i.status === "confirmed"));
  assert.equal(sim.state().configured.th, 8); assert.equal(svc.paused, false);
  assert.ok(reg.list().every((s) => s.sent_slot === s.slot && s.sent_interval === 300));
  const t = Date.now(); sim.tick(t + 5000); await svc.pollNow(t + 6000);
  const v = buildView(db, reg, svc, true, t + 6000); assert.ok(v.sensors.every((s) => s.status === "ok" && s.syncState === "in_gateway" && typeof s.temperature === "number" && s.voltage! > 3 && s.rssi! < -60));
  assert.equal((await svc.preview("th")).writes.length, 0);                    // second Send: nothing to write
});
test("rejected write: that serial FAILED with reason, others confirmed, polling resumes", async () => {
  const { sim, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 3)); sim.rejectSerials.add(POOL[1]);
  const [r] = await svc.sync(A, ["th"], false); assert.equal(r.ok, false);
  assert.deepEqual(r.items.map((i) => [i.serial, i.status, i.reason]).sort(), [[POOL[0], "confirmed", undefined], [POOL[1], "failed", "write rejected"], [POOL[2], "confirmed", undefined]]);
  assert.equal(svc.paused, false); assert.equal(reg.get(POOL[1])!.sent_slot, null);
});
test("type full: foreign groups appear after the sensors were added, extra sensor fails with 'type full'; unassigned shows foreign serials, never auto-added", async () => {
  const { sim, reg, svc, db } = await rig(); reg.add(A, "th", POOL.slice(0, 2));                       // slots 0 and 1
  assert.throws(() => reg.add(A, "th", Array.from({ length: 29 }, (_, i) => "0000" + i.toString(16).toUpperCase().padStart(4, "0"))), /full/);   // registry blocks beyond 30
  for (let i = 0; i < 29; i++) sim.preconfigure("th", i, "0000" + i.toString(16).toUpperCase().padStart(4, "0"), 300);   // configured with the maker's tool meanwhile
  (svc as any).n = 0; await svc.pollNow();
  assert.equal(svc.unassigned().length, 29); assert.equal((db.prepare("SELECT COUNT(*) c FROM sensors").get() as any).c, 2);
  const [r] = await svc.sync(A, ["th"], true); assert.equal(r.items.filter((i) => i.status === "confirmed").length, 1); assert.deepEqual(r.items.filter((i) => i.status === "failed").map((i) => i.reason), ["type full"]);
  assert.equal(sim.state().configured.th, 30); assert.equal(svc.unassigned().length, 29);               // foreign groups untouched
});
test("gateway goes down halfway: failed with timeout, retry done, polling never left off, next Send succeeds", async () => {
  const { sim, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 4)); let writes = 0; const h = sim.handle.bind(sim);
  sim.handle = (u, p) => { if (p[0] === 16 && ++writes === 3) sim.silent = true; return h(u, p); };
  const [r] = await svc.sync(A, ["th"], false); assert.equal(r.ok, false); assert.ok(r.items.some((i) => i.status === "failed" && i.reason === "timeout")); assert.equal(svc.paused, false); assert.equal(svc.syncing, false);
  sim.silent = false; sim.handle = h; await svc.pollNow(); const [r2] = await svc.sync(A, ["th"], false); assert.equal(r2.ok, true);
});
test("interval change writes only that group; shows applying until the observed rate matches", async () => {
  const { db, sim, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 3)); await svc.sync(A, ["th"], false);
  reg.update(A, POOL[1], { interval: 60 }); const p = await svc.preview("th"); assert.deepEqual(p.writes.map((w) => [w.serial, w.reason, w.interval]), [[POOL[1], "interval", 60]]);
  assert.equal(buildView(db, reg, svc, true).sensors.find((s) => s.serial === POOL[1])!.syncState, "changed");
  await svc.sync(A, ["th"], false); assert.equal(sim.state().sensors.find((s) => s.serial === POOL[1])!.intervalSec, 60);
  assert.equal(buildView(db, reg, svc, true).sensors.find((s) => s.serial === POOL[1])!.applying, true);
  let t = Date.now(); for (let i = 0; i < 4; i++) { t += 60_000; sim.tick(t); await svc.pollNow(t); }
  assert.equal(buildView(db, reg, svc, true, t).sensors.find((s) => s.serial === POOL[1])!.applying, false);
  assert.throws(() => reg.update(A, POOL[1], { interval: 5 }), HttpError);
});
test("calibration: calibrated value in view + calibrated series, raw kept in history; replace does NOT transfer it", async () => {
  const { db, sim, reg, svc } = await rig(); reg.add(A, "th", [POOL[0]], [], { [POOL[0]]: "Row 1" }); await svc.sync(A, ["th"], false);
  let t = Date.now(); sim.tick(t + 5000); await svc.pollNow(t + 5000);
  const raw = buildView(db, reg, svc, true).sensors[0].temperature!;
  reg.calibrate(A, POOL[0], { metric: "temperature", method: "offset", raw, reference: raw - 0.5, dueAt: Date.now() - 1000 });
  t += 600_000; sim.tick(t); await svc.pollNow(t + 1); sim.setVoltage(POOL[0], 3.0);
  const v = buildView(db, reg, svc, true).sensors[0]; assert.ok(Math.abs(v.temperature! - (v.raw!.temperature! - 0.5)) < 0.01);
  assert.equal(hist(db, POOL[0], "temperature_raw").length, 2); assert.equal(hist(db, POOL[0], "temperature").length, 2);
  assert.ok(buildView(db, reg, svc, false).alarms.some((a) => a.kind === "calibration_due"));
  assert.equal(buildView(db, reg, svc, false).sensors[0].serial, undefined);     // Operators never see serials/slots/raw
  const n = reg.replace(A, POOL[0], POOL[7]); const nv = buildView(db, reg, svc, true).sensors.find((s) => s.serial === n)!;
  assert.equal(nv.label, "Row 1"); assert.equal(nv.calibrated, false); assert.equal(reg.get(POOL[0])!.replaced_by, n); assert.equal(reg.get(n)!.slot, 0);
  await assert.rejects(svc.sync(A, ["th"], false), (e: any) => e.status === 409 && e.extra.plan.confirm[0].kind === "replaced");
  const [r] = await svc.sync(A, ["th"], true); assert.equal(r.ok, true); assert.equal(sim.state().sensors.find((s) => s.serial === POOL[7])!.slot, 0);
  assert.equal(hist(db, POOL[0], "temperature").length, 2);                      // old serial keeps its history
});
test("calibration limits refuse unless confirmed; reset to raw; history kept", async () => {
  const { reg } = await rig(); reg.add(A, "th", [POOL[0]]);
  assert.throws(() => reg.calibrate(A, POOL[0], { metric: "temperature", method: "offset", raw: 20, reference: 30 }), (e: any) => e.status === 409 && e.extra.needsConfirm);
  reg.calibrate(A, POOL[0], { metric: "temperature", method: "offset", raw: 20, reference: 30, confirmOutOfLimits: true }); assert.equal(reg.calRow(POOL[0], "temperature").check_sensor, 1);
  reg.resetCal(A, POOL[0], "temperature"); assert.equal(reg.calRow(POOL[0], "temperature"), undefined); assert.equal(reg.calHistory(POOL[0]).length, 2);
});
test("frozen sensor -> NO UPDATE after 3 intervals; low voltage; silent gateway -> unknown + gateway alarm without crashing", async () => {
  const { db, sim, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 2)); reg.update(A, POOL[0], { interval: 60 }); reg.update(A, POOL[1], { interval: 60 }); await svc.sync(A, ["th"], false);
  let t = Date.now(); for (let i = 0; i < 2; i++) { t += 60_000; sim.tick(t); await svc.pollNow(t); }
  sim.freeze(POOL[0]); sim.setVoltage(POOL[1], 3.0);
  for (let i = 0; i < 5; i++) { t += 60_000; sim.tick(t); await svc.pollNow(t); }
  const v = buildView(db, reg, svc, true, t); assert.equal(v.sensors[0].status, "no_update"); assert.equal(v.sensors[1].status, "low_battery");
  assert.deepEqual(v.alarms.map((a) => a.kind).sort(), ["low_battery", "no_update"]);
  sim.silent = true; for (let i = 0; i < 3; i++) await svc.pollNow(t);
  const o = buildView(db, reg, svc, true, t); assert.equal(svc.online, false); assert.ok(o.sensors.every((s) => s.status === "unknown")); assert.deepEqual(o.alarms.map((a) => a.kind), ["gateway_offline"]);
  await assert.rejects(svc.sync(A, ["th"], false), /offline/);
  sim.silent = false; await svc.pollNow(t); assert.equal(svc.online, true);
});
test("remove sensor: slot not reused until the confirmed Send; delete-all resets the gateway", async () => {
  const { sim, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 2)); await svc.sync(A, ["th"], false);
  reg.remove(A, POOL[0]); reg.add(A, "th", [POOL[2]]); assert.equal(reg.get(POOL[2])!.slot, 2);          // slot 0 is held by the pending removal, 1 by the other sensor
  await assert.rejects(svc.sync(A, ["th"], false), (e: any) => e.status === 409 && e.extra.plan.confirm[0].kind === "removed");
  const [r] = await svc.sync(A, ["th"], true); assert.equal(r.ok, true); assert.equal(sim.state().configured.th, 2);
  await svc.deleteAll(A); assert.equal(sim.state().configured.th, 0); assert.ok(reg.list().every((s) => s.sent_slot === null));
});
test("backup export/import round trip keeps sensors, intervals, calibrations, structure; all NOT SENT after restore", async () => {
  const { db, reg, svc } = await rig(); reg.add(A, "th", POOL.slice(0, 2)); await svc.sync(A, ["th"], false); const z = reg.addZone(A, "GH1", "climate"); reg.assignZone(A, POOL[0], z);
  reg.update(A, POOL[0], { interval: 60 }); reg.calibrate(A, POOL[0], { metric: "humidity", method: "manual", offset: 2, gain: 1.02 });
  const b = JSON.parse(JSON.stringify(reg.exportAll())); reg.restore(A, b);
  assert.equal(reg.list().length, 2); assert.equal(reg.get(POOL[0])!.reporting_interval, 60); assert.equal(reg.calRow(POOL[0], "humidity").gain, 1.02); assert.equal(reg.points().length, 2);
  assert.ok(reg.list().every((s) => s.sent_slot === null)); assert.throws(() => reg.restore(A, { format: "x" }), HttpError); assert.throws(() => reg.restore(A, { ...b, sensors: [b.sensors[0], b.sensors[0]] }), /duplicate/); void db;
});
