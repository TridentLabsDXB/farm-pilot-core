import { test, after } from "node:test"; import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js";
import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js";
import { ModbusMaster } from "../src/drivers/modbus/master.js";
import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { ModbusException } from "../src/drivers/modbus/frames.js";

const map = loadRegMap("config/gateway-thingsend.yaml");
const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
async function rig(framing: "mbap" | "rtu") {
  const sim = new GatewaySim(map); const srv = serveSim(sim, 0, framing); await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as AddressInfo).port; const tr = createTransport({ type: framing === "mbap" ? "tcp" : "rtu-tcp", host: "127.0.0.1", port });
  const master = new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 400, retries: 1 }); closers.push(() => { void tr.close(); srv.close(); });
  return { sim, drv: new GatewayDriver(master, map), master };
}
for (const framing of ["mbap", "rtu"] as const) {
  test(`[${framing}] system registers, write groups, read back config, data decode`, async () => {
    const { sim, drv } = await rig(framing); const t0 = Date.now();
    assert.deepEqual(await drv.readSystem(), { address: 7, groupAddress: 300, version: 0x200 });
    await drv.writeGroup("th", 1, { serial: "112600310", interval: 10 }); await drv.writeGroup("th", 3, { serial: "112600311", interval: 5 });
    const cfg = await drv.readConfig("th");
    assert.equal(cfg.length, 30); assert.equal(cfg[0].slot, 1); assert.equal(cfg[29].slot, 30); assert.deepEqual([cfg[0].serial, cfg[0].interval, cfg[1].serial, cfg[2].serial, cfg[2].interval], ["112600310", 10, null, "112600311", 5]);
    assert.equal((await drv.readData("th", 3))[0].allZero, true);          // configured but nothing received yet
    sim.tick(t0 + 5000);
    const d = await drv.readData("th", 3); assert.equal(d.length, 3); assert.deepEqual(d.map((c) => c.slot), [1, 2, 3]);      // only up to the highest configured slot
    assert.equal(d[0].allZero, false); assert.equal(d[1].allZero, true); assert.ok(d[0].values.temperature > 10 && d[0].values.voltage > 3 && d[0].values.rssi < -60);
    await drv.clearGroup("th", 1); assert.equal((await drv.readConfig("th"))[0].serial, null); assert.equal((await drv.readData("th", 1))[0].allZero, true);
  });
}
test("exceptions: bad address, delete-all, reject injection, silent gateway times out, address guard", async () => {
  const { sim, drv, master } = await rig("mbap");
  await assert.rejects(master.read(4, 0x0900, 1), (e: any) => e instanceof ModbusException && e.code === 2);
  await assert.rejects(master.read(3, 0x0100, 1), (e: any) => e instanceof ModbusException);          // FC03 on the config area: strict split
  await drv.writeGroup("th", 2, { serial: "112600312", interval: 10 }); await drv.deleteAll(); assert.equal((await drv.readConfig("th")).every((g) => g.serial === null), true);
  sim.rejectSerials.add("112600313"); await assert.rejects(drv.writeGroup("th", 1, { serial: "112600313", interval: 10 }), (e: any) => e.code === 4);
  sim.rejectAll = true; await assert.rejects(drv.clearGroup("th", 1), (e: any) => e.code === 4); sim.rejectAll = false;
  await assert.rejects(drv.writeGroup("th", 1, { serial: "112600312", interval: 4 }), /outside/);
  await assert.rejects(drv.writeGroup("th", 0, { serial: "112600312", interval: 10 }), /slot out of range/); await assert.rejects(drv.writeGroup("th", 31, { serial: "112600312", interval: 10 }), /slot out of range/);
  for (const a of [0, 123, 160, 255]) await assert.rejects(drv.setAddress(a), /never 123 or 160/);
  sim.silent = true; await assert.rejects(drv.readSystem(), /timeout/);
});
test("queue: a write queued behind polls runs before the remaining polls", async () => {
  const { drv, master } = await rig("mbap"); const order: string[] = [];
  const polls = [0, 1, 2, 3].map((i) => master.read(4, 0, 1).then(() => order.push("poll" + i)));
  const w = master.write1(0x0003, 0).then(() => order.push("write"));
  await Promise.all([...polls, w]); assert.ok(order.indexOf("write") <= 1, order.join(","));   // poll0 may already be on the wire, nothing else may go first
  void drv;
});
test("replay: recorded register values appear at their time", async () => {
  const { sim, drv } = await rig("mbap"); sim.preconfigure("th", 1, "112600310", 10, 0);
  sim.loadReplay({ frames: [{ t: 0, type: "th", slot: 1, regs: [235, 580, 330, 0xffb0] }, { t: 10, type: "th", slot: 1, regs: [240, 590, 329, 0xffb2] }] }, 1000);
  sim.tick(1000); let v = (await drv.readData("th", 1))[0].values; assert.deepEqual([v.temperature, v.humidity, v.voltage, v.rssi], [23.5, 58, 3.3, -80]);
  sim.tick(12000); v = (await drv.readData("th", 1))[0].values; assert.equal(v.temperature, 24);
});

test("unconfigured groups read 0xFFFF on the wire and decode as empty; a cleared group (zeros) is empty too; delete-all returns to 0xFFFF", async () => {
  const { sim, drv, master } = await rig("mbap");
  const raw = await master.read(4, 0x0100, 8); assert.deepEqual(raw, [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]);
  await drv.writeGroup("th", 2, { serial: "112600317", interval: 5 }); const g = (await master.read(4, 0x0104, 4)); assert.deepEqual(g, [0x06b6, 0x24fd, 5, 0]);   // [serial_hi, serial_lo, ST, CMD]
  let cfg = await drv.readConfig("th"); assert.deepEqual([cfg[0].serial, cfg[1].serial, cfg[1].interval, cfg[2].serial], [null, "112600317", 5, null]);
  await drv.clearGroup("th", 2); assert.deepEqual(await master.read(4, 0x0104, 4), [0, 0, 0, 0]); cfg = await drv.readConfig("th"); assert.equal(cfg[1].serial, null);
  await drv.writeGroup("th", 1, { serial: "11242748", interval: 5 }); await drv.deleteAll(); assert.deepEqual(await master.read(4, 0x0100, 4), [0xffff, 0xffff, 0xffff, 0xffff]); void sim;
});
