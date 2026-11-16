import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-17 -- bench finding: a sensor that goes silent kept showing NO UPDATE on the cards but /alarms had no NO UPDATE alarm.
// Cause: the alarm was raised only for status "no_update" (identical frame). A gateway that answers an ALL-ZERO frame for a silent sensor gives status "no_data",
// the alarm condition vanished and the tracker closed the episode (CONDITION ENDED) in the same second. Now a sensor that HAS reported before and is silent
// longer than its threshold has a NO UPDATE alarm, whichever way the silence shows (frozen frame or zero frame), until data returns (then RECOVERED).
import { test, after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { buildView } from "../src/gateway/health.js"; import { AlarmTracker } from "../src/gateway/alarms.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" }; const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const POOL = ["112600310", "112600311"], MIN = 60_000;
async function rig() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); closers.push(() => { void tr.close(); srv.close(); });
  const reg = new Registry(db, map), svc = new GatewayService(db, reg, new Ingest(db), new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  await svc.pollNow(); reg.add(A, "th", POOL); await svc.sync(A, ["th"], false);
  const t0 = Date.now() + 10 * MIN; sim.tick(t0); await svc.pollNow(t0);                       // both sensors report: last_change = t0
  return { db, sim, reg, svc, t0, tick: async (t: number) => { sim.tick(t); await svc.pollNow(t); } };
}
const events = (db: any) => db.prepare("SELECT kind,source,raised_at,cleared_at,clear_reason FROM alarm_events WHERE kind='no_update' ORDER BY id").all() as any[];

for (const how of ["zero", "freeze"] as const) test(`NO UPDATE alarm (${how}): silent past the threshold -> raised; still silent after a restart and the next ticks -> still ONE open alarm; data returns -> cleared as RECOVERED`, async () => {
  const x = await rig(); const { db, sim, reg, svc, t0 } = x; let tr = new AlarmTracker(db, reg, svc);
  assert.equal(buildView(db, reg, svc, false, t0 + MIN).alarms.filter((a) => a.kind === "no_update").length, 0, "reporting sensors: no alarm");
  how === "zero" ? sim.zero(POOL[0]) : sim.freeze(POOL[0]);
  await x.tick(t0 + 5 * MIN);                                                                    // first silent poll, 5 min after the last data: below the 15 min threshold
  tr.tick(t0 + 6 * MIN); assert.equal(events(db).length, 0, "not silent long enough yet");
  const late = t0 + 40 * MIN; await x.tick(late);                                                // 40 min of silence, threshold is 3 x 5 min
  assert.equal(buildView(db, reg, svc, false, late).alarms.filter((a) => a.kind === "no_update").length, 1, "the live alarm list has it");
  tr.tick(late); let e = events(db); assert.equal(e.length, 1); assert.equal(e[0].source, POOL[0]); assert.equal(e[0].cleared_at, null);
  await x.tick(late + 30 * MIN); tr.tick(late + 30 * MIN); e = events(db); assert.equal(e.length, 1, "next tick: still the same open alarm, not cleared and not duplicated"); assert.equal(e[0].cleared_at, null);
  tr = new AlarmTracker(db, reg, svc);                                                           // runtime restart: a fresh tracker (settling window) over the same database
  tr.tick(late + 31 * MIN); await x.tick(late + 5 * 3600_000); tr.tick(late + 5 * 3600_000); e = events(db); assert.equal(e.length, 1, "after a restart: still one open alarm"); assert.equal(e[0].cleared_at, null);
  how === "zero" ? sim.unzero(POOL[0]) : sim.freeze(POOL[0], false);
  const back = late + 5 * 3600_000 + 10 * MIN; await x.tick(back); await x.tick(back + 5 * MIN); tr.tick(back + 5 * MIN); e = events(db);
  assert.equal(e.length, 1); assert.equal(e[0].clear_reason, "recovered", "data is back: RECOVERED, not CONDITION ENDED"); assert.ok(e[0].cleared_at !== null);
  assert.equal(buildView(db, reg, svc, false, back + 5 * MIN).alarms.filter((a) => a.kind === "no_update").length, 0);
});
test("a sensor that has NEVER reported (just added, all-zero frames) raises no NO UPDATE alarm: it is NO DATA until its first reading", async () => {
  const x = await rig(); const { db, reg, svc, t0 } = x; reg.add(A, "th", ["112600317"]); await svc.sync(A, ["th"], false);   // 112600317 is in the sim pool but has not transmitted yet
  const late = t0 + 3 * 3600_000; await svc.pollNow(late); const v = buildView(db, reg, svc, true, late);
  const s = v.sensors.find((q: any) => q.serial === "112600317")!; assert.ok(["no_data", "ok"].includes(s.status)); assert.ok(!v.alarms.some((a) => a.serial === "112600317"));
});

// ---- gateway offline: sensors are UNKNOWN, not silent ----
test("gateway offline: only GATEWAY OFFLINE is raised (no per-sensor NO UPDATE flood); an open sensor alarm stays open as unknown; when the gateway returns the sensors are evaluated again (still silent -> alarm, reporting -> none)", async () => {
  const x = await rig(); const { db, sim, reg, svc, t0 } = x; const tr = new AlarmTracker(db, reg, svc); 
  sim.freeze(POOL[1]); await x.tick(t0 + 40 * MIN); tr.tick(t0 + 40 * MIN);                          // sensor 2 is frozen and past its threshold: one open NO UPDATE
  assert.deepEqual(events(db).map((e) => [e.source, e.cleared_at]), [[POOL[1], null]]);
  sim.silent = true;                                                                                // the GATEWAY stops answering (link down)
  const cycles = reg.settings().offlineCycles; for (let i = 0; i < cycles + 1; i++) await svc.pollNow(t0 + 3 * 3600_000 + i * 30_000); assert.equal(svc.online, false, "gateway is offline");
  const far = t0 + 6 * 3600_000; tr.tick(far);
  assert.deepEqual(buildView(db, reg, svc, false, far).alarms.map((a) => a.kind), ["gateway_offline"], "live list: the gateway alarm only, no sensor alarms (their state is unknown)");
  const h = db.prepare("SELECT kind,source,cleared_at FROM alarm_events ORDER BY id").all() as any[]; assert.equal(h.filter((r) => r.kind === "gateway_offline").length, 1); assert.equal(h.filter((r) => r.kind === "no_update").length, 1, "no new sensor episodes while offline");
  assert.equal(h.find((r) => r.kind === "no_update").cleared_at, null, "the open sensor alarm is frozen open, not cleared");
  assert.equal(tr.history(50, false).find((r) => r.kind === "no_update")!.unknown, true, "and reported as unknown");
  sim.silent = false;                                                                               // the gateway comes back; sensor 2 is still frozen, sensor 1 keeps reporting
  const back = far + 10 * MIN; await x.tick(back); assert.equal(svc.online, true); tr.tick(back);                 // evaluated on the FIRST tick after the return: the reporting sensor is not flagged by its old last_change
  assert.ok(!events(db).some((e) => e.source === POOL[0]), "sensor 1 never alarmed"); await x.tick(back + 5 * MIN); tr.tick(back + 5 * MIN);
  const live = buildView(db, reg, svc, true, back + 5 * MIN).alarms; assert.ok(!live.some((a) => a.kind === "gateway_offline"));
  assert.deepEqual(live.filter((a) => a.kind === "no_update").map((a) => a.serial), [POOL[1]], "evaluated again: only the sensor that is really silent");
  assert.equal(events(db).length, 1, "same episode continues, no duplicate"); assert.equal(events(db)[0].cleared_at, null);
});
