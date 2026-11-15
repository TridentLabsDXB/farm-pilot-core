import { test } from "node:test"; import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeField, loadRegMap, parseRegMap, regsToSerial, serialToRegs, RegMapError } from "../src/drivers/modbus/regmap.js";
import { crc16, rtuFrameLength, rtuWrap, rtuUnwrap, readPdu } from "../src/drivers/modbus/frames.js";
const TEXT = readFileSync("config/gateway-thingsend.yaml", "utf8");
const bad = (edit: (t: string) => string) => { try { parseRegMap(edit(TEXT)); } catch (e) { if (e instanceof RegMapError) return e.problems.join("\n"); throw e; } return ""; };

test("shipped map loads; th enabled, placeholders disabled; ranges match the manual", () => {
  const m = loadRegMap("config/gateway-thingsend.yaml");
  assert.equal(m.types.th.enabled, true); for (const k of ["gas", "light", "door_smoke", "soil"]) assert.equal(m.types[k].enabled, false);
  assert.equal(m.types.th.config.base + m.types.th.groups * 4 - 1, 0x0177); assert.equal(m.types.gas.config.base + 15 * 4 - 1, 0x023b); assert.equal(m.types.soil.config.base + 10 * 4 - 1, 0x0627);
  assert.equal(m.types.soil.groups, 10); assert.equal(m.types.soil.data.base, 0x5001);
});
test("overlapping ranges are rejected (soil data at 0x4001 collides with door_smoke)", () => assert.match(bad((t) => t.replace("base: 0x5001", "base: 0x4001")), /overlap/));
test("field offset outside regs_per_channel is rejected", () => assert.match(bad((t) => t.replace("rssi:        { reg: 3, type: i16", "rssi:        { reg: 4, type: i16")), /outside regs_per_channel/));
test("u32 field must fit with both registers", () => assert.match(bad((t) => t.replace("lux:     { reg: 0, type: u32", "lux:     { reg: 3, type: u32")), /outside regs_per_channel/));
test("gateway address 123 / 160 refused", () => { for (const a of [123, 160, 0, 255]) assert.match(bad((t) => t.replace("default_gateway_address: 1 ", `default_gateway_address: ${a} `)), /never 123 or 160/); });
test("yaml garbage gives a clear error, not a crash", () => assert.match(bad(() => "types: [unclosed"), /YAML|types/));

test("decode: i16 negative, u16 scale, big-endian values", () => {
  const t = loadRegMap("config/gateway-thingsend.yaml").types.th.data.fields;
  assert.equal(decodeField([0xff9c], { ...t.temperature, reg: 0 }), -10.0);   // 0xFF9C = -100 -> -10.0 C
  assert.equal(decodeField([0, 587], { ...t.humidity, reg: 1 }), 58.7);
  assert.equal(decodeField([0, 0, 360], { ...t.voltage, reg: 2 }), 3.6);
  assert.equal(decodeField([0, 0, 0, 0xffb0], { ...t.rssi, reg: 3 }), -80);
});
test("decode: u32 word order", () => {
  const f = { reg: 0, type: "u32" as const, scale: 1, unit: "lux", calibrated: false, word_order: "high_first" as const };
  assert.equal(decodeField([0x0001, 0x0002], f), 65538); assert.equal(decodeField([0x0001, 0x0002], { ...f, word_order: "low_first" }), 0x00020001);
  assert.equal(decodeField([0x0001, 0x0000], { ...f, type: "u32", scale: 0.001 }), 65.536);
});
test("serial <-> registers round trip, both word orders, high bit set", () => {
  for (const o of ["high_first", "low_first"] as const) { const r = serialToRegs("FA01B3F2", o); assert.equal(regsToSerial(r[0], r[1], o), "FA01B3F2"); }
  assert.deepEqual(serialToRegs("4A01B3F2", "high_first"), [0x4a01, 0xb3f2]);
});
test("crc16 known vector and RTU frame helpers", () => {
  assert.equal(crc16(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a])), 0xcdc5);   // standard Modbus example, CRC bytes C5 CD
  const f = rtuWrap(1, readPdu(3, 1, 4)); assert.equal(rtuUnwrap(f)?.unit, 1); f[3] ^= 1; assert.equal(rtuUnwrap(f), null);
  assert.equal(rtuFrameLength(Buffer.from([1, 3, 8]), "res"), 13); assert.equal(rtuFrameLength(Buffer.from([1, 0x83]), "res"), 5);
});
