// Slot -> Modbus address mapping. Slots are numbered 1..groups. Slot 1 is the FIRST group of the type, slot N is base + (N-1) * regs.
// Checked three ways: the address helpers, the bytes actually put on the wire (recording transport), and the simulator's registers.
import { test } from "node:test"; import assert from "node:assert/strict";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import type { ModbusTransport } from "../src/drivers/modbus/transport.js";

const map = loadRegMap("config/gateway-thingsend.yaml");
/** Transport wired straight to the simulator that records every request PDU. */
function rig() {
  const sim = new GatewaySim(map); const sent: Buffer[] = [];
  const tr: ModbusTransport = { async request(unit, pdu) { sent.push(Buffer.from(pdu)); const r = sim.handle(unit, pdu); if (!r) throw new Error("timeout"); return r; }, async close() {} };
  return { sim, sent, drv: new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 50, retries: 0 }), map) };
}

test("T/H: slot 1 = config 0x0100 / data 0x0001, slot 30 = config 0x0174 / data 0x0075", () => {
  const { drv } = rig();
  assert.equal(drv.groupAddr("th", 1), 0x0100); assert.equal(drv.dataAddr("th", 1), 0x0001);
  assert.equal(drv.groupAddr("th", 30), 0x0100 + 29 * 4); assert.equal(drv.groupAddr("th", 30), 0x0174);
  assert.equal(drv.dataAddr("th", 30), 0x0001 + 29 * 4); assert.equal(drv.dataAddr("th", 30), 0x0075);
});
test("every type (incl. the disabled placeholders): slot 1 is the first group, slot N the last", () => {
  const { drv } = rig();
  for (const t of Object.values(map.types)) {
    assert.equal(drv.groupAddr(t.key, 1), t.config.base, t.key); assert.equal(drv.dataAddr(t.key, 1), t.data.base, t.key);
    assert.equal(drv.groupAddr(t.key, t.groups), t.config.base + (t.groups - 1) * t.config.regs_per_group, t.key); assert.equal(drv.dataAddr(t.key, t.groups), t.data.base + (t.groups - 1) * t.data.regs_per_channel, t.key);
  }
  assert.equal(drv.groupAddr("soil", 10), 0x0624); assert.equal(drv.groupAddr("gas", 15), 0x0238);   // last group of the 10 / 15 group types, 4 registers wide, ends at 0x0627 / 0x023B
});
test("on the wire: writing slot 1 and slot 30 hits 0x0100 and 0x0174 (FC16), reading config hits 0x0100 (FC04), reading data hits 0x0001 (FC03)", async () => {
  const { drv, sent, sim } = rig();
  await drv.writeGroup("th", 1, { serial: "112600310", interval: 10 }); await drv.writeGroup("th", 30, { serial: "112600311", interval: 10 });
  assert.deepEqual(sent.map((p) => [p[0], p.readUInt16BE(1), p.readUInt16BE(3)]), [[16, 0x0100, 4], [16, 0x0174, 4]]);
  await drv.readConfig("th"); await drv.readData("th", 30);
  assert.deepEqual(sent.slice(2).map((p) => [p[0], p.readUInt16BE(1), p.readUInt16BE(3)]), [[4, 0x0100, 120], [3, 0x0001, 120]]);
  const cfg = sim.cfg.get("th")!; assert.equal(cfg[0], 0x06b6); assert.equal(cfg[1], 0x24f6); assert.equal(cfg[0x74], 0x06b6); assert.equal(cfg[0x75], 0x24f7);   // 112600310 = 0x06B624F6, 112600311 = 0x06B624F7   // first and last group of the block
  assert.equal(cfg.slice(4, 0x74).every((x) => x === 0xffff), true);                                                                                                       // nothing in between
});
test("data of slot 1 and slot 30 comes from data 0x0001 and 0x0075", async () => {
  const { drv, sim } = rig(); const d = sim.data.get("th")!;
  d.splice(0, 4, 235, 580, 360, 0xffb0);                       // registers 0x0001..0x0004 = slot 1
  d.splice(29 * 4, 4, 111, 222, 333, 0xff00);                  // registers 0x0075..0x0078 = slot 30
  const ch = await drv.readData("th", 30); assert.equal(ch[0].slot, 1); assert.equal(ch[0].values.temperature, 23.5); assert.equal(ch[29].slot, 30); assert.equal(ch[29].values.temperature, 11.1); assert.equal(ch[29].values.humidity, 22.2);
});
test("slot 0 and slot 31 are refused BEFORE anything is sent to the gateway", async () => {
  const { drv, sent } = rig();
  for (const slot of [0, 31, -1, 1.5]) { await assert.rejects(drv.writeGroup("th", slot, { serial: "112600310", interval: 10 }), /slot out of range/); await assert.rejects(drv.clearGroup("th", slot), /slot out of range/); }
  await assert.rejects(drv.readData("th", 31), /slot out of range/); assert.throws(() => drv.dataAddr("th", 31), /slot out of range/); assert.throws(() => drv.groupAddr("th", 31), /slot out of range/);
  assert.equal(sent.length, 0);
});
