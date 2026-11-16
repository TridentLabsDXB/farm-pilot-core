import { test } from "node:test"; import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeChannel, decodeField, groupIsEmpty, loadRegMap, parseRegMap, regsToSerial, serialToRegs, RegMapError } from "../src/drivers/modbus/regmap.js";
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
test("gateway address 123 / 160 refused", () => { for (const a of [123, 160, 0, 255]) assert.match(bad((t) => t.replace("default_gateway_address: 7 ", `default_gateway_address: ${a} `)), /never 123 or 160/); });
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
test("serial <-> registers: printed serial is the plain decimal of the u32, high word first (bench: 06 b6 24 fd = 112600317, 00 ab 8c fc = 11242748)", () => {
  assert.deepEqual(serialToRegs("112600317", "high_first"), [0x06b6, 0x24fd]); assert.equal(regsToSerial(0x06b6, 0x24fd, "high_first"), "112600317");
  assert.equal(regsToSerial(0x00ab, 0x8cfc, "high_first"), "11242748"); assert.deepEqual(serialToRegs("11242748", "high_first"), [0x00ab, 0x8cfc]);   // fewer digits, no padding
  for (const o of ["high_first", "low_first"] as const) for (const n of ["4294967295", "3000000000", "112600317", "1"]) { const r = serialToRegs(n, o); assert.equal(regsToSerial(r[0], r[1], o), n); }
  assert.throws(() => serialToRegs("4294967296", "high_first")); assert.throws(() => serialToRegs("4A01B3F2", "high_first"));
});
test("bench data frame 010e 01d4 017f ffd9 decodes to 27.0 C, 46.8 %RH, 3.83 V, -39 dBm", () => {
  const t = loadRegMap("config/gateway-thingsend.yaml").types.th; const v = decodeChannel([0x010e, 0x01d4, 0x017f, 0xffd9], t);
  assert.deepEqual(v, { temperature: 27, humidity: 46.8, voltage: 3.83, rssi: -39 });
});
test("config groups: 0xFFFF slot is empty, [serial_hi, serial_lo, ST, CMD] group is read, zeros also empty, a half-marker group is not", () => {
  const m = loadRegMap("config/gateway-thingsend.yaml"), c = m.types.th.config;
  assert.equal(m.empty_marker, 0xffff); assert.equal(groupIsEmpty([0xffff, 0xffff, 0xffff, 0xffff], c, m.empty_marker), true); assert.equal(groupIsEmpty([0, 0, 0, 0], c, m.empty_marker), true);
  assert.equal(groupIsEmpty([0x06b6, 0x24fd, 5, 0], c, m.empty_marker), false); assert.equal(groupIsEmpty([0x06b6, 0xffff, 5, 0], c, m.empty_marker), false);
});
test("interval unit is minutes 5..240 with a seconds multiplier; map v2 carries gateway address 7 and decimal serial pattern", () => {
  const m = loadRegMap("config/gateway-thingsend.yaml"); const i = m.types.th.config.interval;
  assert.deepEqual([i.unit, i.unit_sec, i.min, i.max, m.types.th.default_interval, m.types.th.presets], ["minutes", 60, 5, 240, 5, [5, 10, 15, 30]]);
  assert.equal(m.default_gateway_address, 7); assert.equal(m.serial_pattern.test("112600317"), true); assert.equal(m.serial_pattern.test("4A01B3F2"), false);
  assert.match(bad((t) => t.replace("unit: minutes, min: 5, max: 240 }             #", "unit: hours, min: 5, max: 240 }             #")), /interval.unit/);
});
test("crc16 known vector and RTU frame helpers", () => {
  assert.equal(crc16(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a])), 0xcdc5);   // standard Modbus example, CRC bytes C5 CD
  const f = rtuWrap(1, readPdu(3, 1, 4)); assert.equal(rtuUnwrap(f)?.unit, 1); f[3] ^= 1; assert.equal(rtuUnwrap(f), null);
  assert.equal(rtuFrameLength(Buffer.from([1, 3, 8]), "res"), 13); assert.equal(rtuFrameLength(Buffer.from([1, 0x83]), "res"), 5);
});
