import "./isolate.js";
// CONTROL DEVICES > Ashining A100 (core-control-devices-ashining-a100-page.md). No radio, no fan: the "unit" is the fake A100 (a real TCP server on a loopback port) and every test checks that nothing
// reaches a fan: data frames are captured by the fake A100 and counted.
import test, { after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
import { PortStore } from "../src/ports/store.js"; import { PortManager } from "../src/ports/manager.js"; import { validateAssignment, validateDevice, type DeviceRow } from "../src/ports/validate.js";
import { buildCfgFrame, buildOpFrame, checkBytes, parseCfgAnswer, parseOpFrame, targetPrefix } from "../src/a100/frames.js";
import { REG_LEN, regBytes, channelMhz, decodeAck, decodeFormat, decodeOptions, decodeRadio, encodeAck, encodeFormat, encodeRadio, isFactoryKey, modeName, REG, setOption } from "../src/a100/registers.js";
import { A100Service } from "../src/a100/service.js"; import { A100Sim, serveA100 } from "../src/tools/a100-sim/sim.js";
import { readFileSync, readdirSync } from "node:fs"; import { join } from "node:path";

const A = { username: "admin", role: "admin" }, closers: (() => void | Promise<void>)[] = []; after(async () => { for (const c of closers.reverse()) await c(); });
const hex = (b: Buffer) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const env = { transport: "off" as const, host: "", port: 0, serialPath: "", baud: 9600, parity: "none" as const, address: 0, timeoutMs: 500, retries: 0 };

async function rig(opts: { link?: boolean } = {}) {
  const db = openDb(":memory:"), store = new PortStore(db); store.migrateFromEnv(env, 1); db.prepare("DELETE FROM bus_devices WHERE kind='weather'").run();
  const sim = new A100Sim(), srv = serveA100(sim, 0); await new Promise((r) => srv.once("listening", r)); const port = (srv.address() as AddressInfo).port; closers.push(() => { srv.close(); });
  const pm = new PortManager(db, store, null, null); await pm.start(); closers.push(() => pm.stop());
  await pm.applyPort(A, 2, { enabled: true, transport: "tcp", tcp_host: "127.0.0.1", tcp_port: port, tcp_framing: "rtu", timeout_ms: 400, retries: 0, turnaround_ms: 0 });
  const svc = new A100Service(db, () => pm, { sleep: async () => {}, timeoutMs: 400 }); if (opts.link !== false) svc.setLink(A, { port_id: 2, enabled: true });
  const audits = () => (db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'a100.%' ORDER BY id").all() as { action: string; detail: string }[]);
  return { db, sim, pm, svc, store, audits };
}
const withPayload = (r: Awaited<ReturnType<typeof rig>>, payload = "a1b2c3", extra: Record<string, unknown> = {}) => r.svc.saveDevice(A, null, { name: "Test receiver", kind: "fan", role: "exhaust", dest_group: 1, dest_addr: 7, channel: 9, payloads: { on: payload, off: "d4" }, ...extra });

test("frame builder matches the manual example (read all parameters) and the check bytes", () => {
  const f = buildOpFrame({ write: false, start: 0x04, len: 0x1c });
  assert.equal(hex(f), "af af 55 55 5a ff 00 04 1c 81 bd 50 50 aa aa a5 0d 0a");
  assert.deepEqual(checkBytes(Buffer.from([0xaf, 0xaf, 0x55, 0x55, 0x5a, 0xff, 0x00, 0x04, 0x1c])), [0x81, 0xbd]);
  const w = buildOpFrame({ write: true, start: 0x06, len: 1, data: Buffer.from([0x02, 0xfa]) }), p = parseOpFrame(w);                  // LEN counts REGISTERS: one register, two data bytes
  assert.ok(p && p !== "bad" && p.write && p.start === 6 && p.len === 1 && p.data.equals(Buffer.from([2, 0xfa])));
  const bad = Buffer.from(f); bad[9] ^= 1; assert.equal(parseOpFrame(bad), "bad"); assert.equal(parseOpFrame(f.subarray(0, 10)), null);
  assert.throws(() => buildOpFrame({ write: true, start: 6, len: 1, data: Buffer.from([1]) }), /byte length of the registers/);
});
test("LEN counts registers and the data bytes equal the sum of their byte lengths (key = 80 0B 01 + 16 bytes; two registers = 2 + 2 bytes)", () => {
  const key = Buffer.alloc(16, 0x41), f = buildOpFrame({ write: true, start: 0x0b, len: 1, data: key }); assert.equal(hex(f.subarray(4, 9)), "5a 7f 80 0b 01"); assert.ok(f.subarray(9, 25).equals(key));
  assert.equal(regBytes(0x06, 2), 4); assert.equal(regBytes(0x0b, 1), 16); assert.equal(regBytes(0x04, 0x1c), null);                           // 0x10 to 0x13 are not in the map: no length check there
  assert.doesNotThrow(() => buildOpFrame({ write: true, start: 0x06, len: 2, data: Buffer.alloc(4) })); assert.throws(() => buildOpFrame({ write: true, start: 0x06, len: 2, data: Buffer.alloc(2) }), /byte length/);
  for (const [r, n] of [[0x00, 20], [0x01, 4], [0x04, 4], [0x05, 1], [0x06, 2], [0x07, 2], [0x08, 1], [0x09, 2], [0x0a, 1], [0x0b, 16], [0x0c, 5], [0x0d, 1], [0x0e, 1], [0x0f, 2], [0x14, 1], [0x16, 1], [0x17, 2], [0x18, 1], [0x1f, 1]]) assert.equal(REG_LEN[r], n, "register 0x" + r.toString(16));
  const reply = Buffer.concat([Buffer.from([0xaf, 0xaf, 0x55, 0x55, 0x5a, 0xff, 0x00, 0x06, 0x01, 0x02, 0xfa]), Buffer.from([0, 0, 0x50, 0x50, 0xaa, 0xaa, 0xa5, 0x0d, 0x0a])]); const [sm, xr] = checkBytes(reply.subarray(0, 11)); reply[11] = sm; reply[12] = xr;
  const pr = parseOpFrame(reply); assert.ok(pr && pr !== "bad" && !pr.write && pr.data.length === 2);                                         // a read answer: `00 REG LEN` + the register's bytes, length found from the frame
});
test("configuration-mode frames and answers (CMD REG LEN DATA; 0x80 saved, 0xC0 failed)", () => {
  assert.equal(hex(buildCfgFrame({ write: false, reg: 0x06, len: 1 })), "00 06 01"); assert.equal(hex(buildCfgFrame({ write: true, reg: 0x06, len: 1, data: Buffer.from([2, 0xfa]) })), "80 06 01 02 fa");
  assert.equal(hex(buildCfgFrame({ write: false, reg: 0x06, len: 1, remote: true })), "40 06 01");
  assert.deepEqual(parseCfgAnswer(Buffer.from([0x80, 6, 1]), 6)?.ok, true); assert.equal(parseCfgAnswer(Buffer.from([0xc0, 6, 1]), 6)?.ok, false);
  assert.equal(parseCfgAnswer(Buffer.from([0x00, 6, 1, 2]), 6), null); assert.equal(hex(parseCfgAnswer(Buffer.from([0x00, 6, 1, 2, 0xfa]), 6)!.data), "02 fa");
  assert.ok(!/buildCfgFrame|parseCfgAnswer/.test(readFileSync("src/a100/link.ts", "utf8").replace(/\/\/.*$/gm, "")), "READ, WRITE and TEST LINK use operating-mode frames only");
});
test("register codec: channel to MHz, power, air rate (the 0x02FC case), serial format, mode, ack, options", () => {
  assert.equal(channelMhz(23), 433); assert.equal(channelMhz(0), 410);
  assert.deepEqual(decodeRadio(0x02fc), { channel: 23, mhz: 433, powerDbm: 30, airKbps: 19.2 });      // the manual's factory table value 02FC decodes to 19.2 kbps
  assert.deepEqual(decodeRadio(0x02fa), { channel: 23, mhz: 433, powerDbm: 30, airKbps: 4.8 }); assert.equal(decodeRadio(0x02bd).airKbps, 38.4);   // 02FA and 02BD are the other two values the manual shows; none is an expected default
  for (const [p, bits] of [[21, 0], [24, 1], [27, 2], [30, 3]] as const) assert.equal(decodeRadio((5 << 5) | (bits << 3)).powerDbm, p);
  for (const [i, k] of [1.2, 2.4, 4.8, 9.6, 19.2, 38.4, 50, 62.5].entries()) assert.equal(decodeRadio(i).airKbps, k);
  assert.equal(encodeRadio({ channel: 23, powerDbm: 30, airKbps: 19.2 }), 0x02fc); assert.throws(() => encodeRadio({ channel: 1, powerDbm: 29, airKbps: 2.4 }), /power/); assert.throws(() => encodeRadio({ channel: 1, powerDbm: 30, airKbps: 3 }), /air rate/);
  assert.deepEqual(decodeFormat(0), { dataBits: 8, stopBits: 1, parity: "none" }); assert.deepEqual(decodeFormat(0x10 | 0x20 | 0b100), { dataBits: 9, stopBits: 2, parity: "even" }); assert.equal(decodeFormat(0b110).parity, "odd");
  for (const f of [{ dataBits: 8, stopBits: 1, parity: "none" }, { dataBits: 9, stopBits: 2, parity: "odd" }] as const) assert.deepEqual(decodeFormat(encodeFormat(f)), f);
  assert.equal(modeName(1), "transparent"); assert.equal(modeName(2), "target transmission"); assert.equal(modeName(4), "master-slave"); assert.equal(modeName(0xf001), "control IO"); assert.equal(modeName(0x1234), "0x1234");
  assert.deepEqual(decodeAck(0x85), { enabled: true, retries: 5 }); assert.equal(encodeAck({ enabled: true, retries: 5 }), 0x85); assert.throws(() => encodeAck({ enabled: true, retries: 128 }));
  assert.equal(decodeOptions(0x10).remoteConfig, true); assert.equal(decodeOptions(0).remoteConfig, false); assert.equal(setOption(0, "remoteConfig", true), 0x10); assert.equal(setOption(0x10, "remoteConfig", false), 0);
  assert.equal(isFactoryKey(Buffer.from("www.ashining.com")), true); assert.equal(isFactoryKey(Buffer.from("www.ashining.con")), false);
});
test("target transmission prefix is address high, address low, channel", () => { assert.equal(hex(targetPrefix(1, 7, 9)), "01 07 09"); assert.throws(() => targetPrefix(256, 0, 0)); });

test("fan_link has no Modbus address and holds its port alone", () => {
  const ports = [{ id: 2 } as any]; const link: DeviceRow = { id: 5, kind: "fan_link", model: "A100-L400M30", port_id: 2, modbus_address: 0, poll_interval_s: 60, enabled: true };
  assert.deepEqual(validateDevice(link, ports), []);                                                       // address 0 is fine for the radio link
  assert.match(validateDevice({ ...link, kind: "weather" }, ports).join(), /Modbus address/);              // every other kind still needs one
  const other: DeviceRow = { id: 6, kind: "weather", model: "WN90LP", port_id: 2, modbus_address: 144, poll_interval_s: 30, enabled: true };
  assert.match(validateAssignment([link, other]).join(), /needs the port to itself/); assert.deepEqual(validateAssignment([link, { ...other, port_id: 1 }]), []); assert.deepEqual(validateAssignment([link, { ...other, enabled: false }]), []);
});
test("the Ports manager never sends a Modbus probe over the A100 link", async () => {
  const r = await rig(); const t = await r.pm.test(2); assert.equal(t.results[0]?.result, "skipped"); await new Promise((x) => setTimeout(x, 150));
  assert.deepEqual(r.sim.reads, []); assert.equal(r.sim.swallowed.length, 0);                                // no register read, no stray bytes
  assert.equal(r.store.devices().find((d) => d.kind === "fan_link")!.modbus_address, 0);
});
test("setLink refuses a port that another enabled device already uses", async () => {
  const r = await rig({ link: false }); assert.throws(() => r.svc.setLink(A, { port_id: 1, enabled: true }), /needs the port to itself/);
  r.svc.setLink(A, { port_id: 2, enabled: true }); assert.ok(r.audits().some((a) => a.action === "a100.link.update"));
});

test("READ FROM UNIT shows the values; the factory key raises DEFAULT KEY IN USE and no key leaves the service", async () => {
  const r = await rig(); const res = await r.svc.readFromUnit(A); const p = res.params;
  assert.equal(p.version, "A100-L400M30-v1.2.00"); assert.deepEqual(p.radio, { channel: 23, mhz: 433, powerDbm: 30, airKbps: 4.8 }); assert.equal(p.mode?.name, "target transmission"); assert.equal(p.defaultKey, true);
  assert.ok(res.warnings.some((w) => w.code === "default_key" && /DEFAULT KEY IN USE/.test(w.text))); assert.equal(res.first, true);
  const all = JSON.stringify([res, r.svc.view(), r.audits(), r.db.prepare("SELECT snapshot FROM a100_link").all()]); assert.ok(!all.includes("ashining.com"), "key text leaked"); assert.ok(!all.includes(Buffer.from("www.ashining.com").toString("hex")), "key hex leaked");
  assert.equal(p.raw[REG.KEY], undefined);
  r.sim.regs.set(REG.KEY, Buffer.from("0123456789abcdef")); const again = await r.svc.readFromUnit(A); assert.equal(again.params.defaultKey, false); assert.ok(!again.warnings.some((w) => w.code === "default_key"));
});
test("serial register versus port settings mismatch is shown", async () => {
  const r = await rig(); const b = Buffer.alloc(4); b.writeUInt32BE(19200); r.sim.regs.set(REG.BAUD, b); const res = await r.svc.readFromUnit(A);
  assert.ok(res.warnings.some((w) => w.code === "serial_mismatch" && /baud 19200 on the unit, 9600 on the port/.test(w.text)));
});
test("TEST LINK checks port, answer and serial match, and sends only register reads: no data frame, no command", async () => {
  const r = await rig(); const t = await r.svc.testLink(A); assert.equal(t.ok, true); assert.deepEqual(t.checks.map((c) => c.name), ["PORT", "A100 ANSWERS", "SERIAL MATCH"]);
  assert.ok(r.svc.link.sent.length > 0 && r.svc.link.sent.every((s) => s.kind === "read")); assert.equal(r.sim.writes.length, 0); assert.equal(r.sim.swallowed.length, 0);
  r.sim.silent = true; const n = await r.svc.testLink(A); assert.equal(n.ok, false); assert.equal(n.checks.find((c) => c.name === "A100 ANSWERS")!.ok, false); assert.equal(r.sim.swallowed.length, 0);
  assert.ok(r.audits().filter((a) => a.action === "a100.test").length === 2);
});
test("TEST LINK on a switched-off link or an unopened port fails with a sentence and sends nothing", async () => {
  const r = await rig({ link: false }); const t = await r.svc.testLink(A); assert.equal(t.ok, false); assert.match(t.checks[0].text, /No RS-485 port/); assert.equal(r.sim.reads.length, 0);
});

test("WRITE TO UNIT: confirmation, a prior read, read-back, audit with old and new values", async () => {
  const r = await rig();
  await assert.rejects(r.svc.writeToUnit(A, { changes: { channel: 5 } }), /confirm/); await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { channel: 5 } }), /READ FROM UNIT first/);
  await r.svc.readFromUnit(A); const res = await r.svc.writeToUnit(A, { confirm: true, changes: { channel: 5, powerDbm: 27 } }); assert.deepEqual(res.written, ["radio"]);
  assert.deepEqual(decodeRadio(r.sim.regs.get(REG.RADIO)!.readUInt16BE(0)), { channel: 5, mhz: 415, powerDbm: 27, airKbps: 4.8 });    // air rate untouched: only what the Admin sent is written
  const a = r.audits().find((x) => x.action === "a100.write")!; const d = JSON.parse(a.detail); assert.equal(d.changes[0].old.channel, 23); assert.equal(d.changes[0].new.channel, 5);
  assert.equal((await r.svc.writeToUnit(A, { confirm: true, changes: { channel: 5 } })).unchanged, true);
  await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { powerDbm: 29 } }), /power must be/); await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { mode: 0x0020 } }), /mode must be/);
});
test("WRITE TO UNIT puts the old values back when a later register fails (REVERT) and refuses while a command is queued", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const before = Buffer.from(r.sim.regs.get(REG.RADIO)!);
  r.sim.refuse.add(REG.MODE); await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { channel: 9, mode: 1 } }), /earlier values were put back/);
  assert.ok(r.sim.regs.get(REG.RADIO)!.equals(before), "radio register must be back at its old value"); assert.ok(r.audits().some((a) => a.action === "a100.write.failed"));
  r.sim.refuse.clear(); (r.svc as any).inflight = 1; await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { channel: 9 } }), /command is still being sent/); (r.svc as any).inflight = 0;
  await r.svc.writeToUnit(A, { confirm: true, changes: { channel: 9 } }); const rv = await r.svc.revert(A, { confirm: true }); assert.equal(rv.ok, true); assert.ok(r.sim.regs.get(REG.RADIO)!.equals(before));
});
test("a write the unit does not store is caught by the read-back", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); r.sim.corruptWrite.add(REG.RETRY_MS); await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { retryMs: 500 } }), /different value/);
});
test("remote configuration changes need their own confirmation", async () => {
  const r = await rig(); await r.svc.readFromUnit(A);
  await assert.rejects(r.svc.writeToUnit(A, { confirm: true, changes: { remoteConfig: true } }), /own confirmation/); await r.svc.writeToUnit(A, { confirm: true, confirmRemote: true, changes: { remoteConfig: true } });
  assert.equal(r.sim.regs.get(REG.OPTIONS)!.readUInt16BE(0) & 0x10, 0x10); assert.ok(r.svc.warnings().some((w) => w.code === "remote_config"));
});
test("SET NEW KEY writes the key to the unit and forgets it: not in the response, the audit, the snapshot or the log", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const key = "Zq7!mK2#pL9@wX4$";
  await assert.rejects(r.svc.setKey(A, { key }), /confirm/); await assert.rejects(r.svc.setKey(A, { key: "short", confirm: true }), /16 printable/);
  const out: string[] = []; const ow = process.stdout.write.bind(process.stdout), oe = process.stderr.write.bind(process.stderr); (process.stdout as any).write = (c: any) => (out.push(String(c)), true); (process.stderr as any).write = (c: any) => (out.push(String(c)), true);
  let res: unknown; try { res = await r.svc.setKey(A, { key, confirm: true }); } finally { process.stdout.write = ow; process.stderr.write = oe; }
  assert.deepEqual(res, { ok: true }); assert.equal(r.sim.regs.get(REG.KEY)!.toString("ascii"), key);
  const all = JSON.stringify([res, r.svc.view(), r.audits(), r.db.prepare("SELECT * FROM a100_link").all(), out]); assert.ok(!all.includes(key)); assert.ok(!all.includes(Buffer.from(key).toString("hex")));
  assert.equal(r.svc.view().params?.defaultKey, false);
});
test("REBOOT and FACTORY RESTORE are disabled; the driver accepts either echo address (0x20/0x21 or 0x22/0x23)", async () => {
  const r = await rig(); await assert.rejects(r.svc.resetUnit(A, { action: "reboot", confirm: "REBOOT" }), /disabled until they are verified/); await assert.rejects(r.svc.resetUnit(A, { action: "factory", confirm: "FACTORY" }), /disabled/);
  assert.equal(r.sim.writes.length, 0); assert.equal(r.svc.view().resetEnabled, false);
  assert.equal((await r.svc.link.command(0x20)).echo, 0x20); r.sim.echoPlus2 = true; assert.deepEqual(await r.svc.link.command(0x21), { answered: true, echo: 0x23 }); r.sim.silent = true; assert.deepEqual(await r.svc.link.command(0x20), { answered: false, echo: null });
  assert.match(readFileSync("web/src/A100Page.tsx", "utf8"), /resetEnabled/);
});
test("answers are parsed by the register map: a wrong length is rejected; 0x17 is accepted as 1 or 2 bytes and always written as 2; every frame is an operating-mode frame", async () => {
  const r = await rig(); r.sim.longRead.add(REG.RADIO); await assert.rejects(r.svc.link.readReg(REG.RADIO), /rejected/); const p = await r.svc.link.readParams(); assert.ok(p.missing.includes("radio") && p.radio === null);
  r.sim.longRead.clear(); r.sim.opt1Byte = true; r.sim.regs.set(REG.OPTIONS, Buffer.from([0x00, 0x10])); const q = await r.svc.link.readParams(); assert.equal(q.optionsRaw, 0x10); assert.equal(q.raw[REG.OPTIONS], "0010"); assert.equal(q.options?.remoteConfig, true);
  r.sim.opt1Byte = false; await r.svc.readFromUnit(A); await r.svc.writeToUnit(A, { confirm: true, confirmRemote: true, changes: { remoteConfig: false } }); assert.equal(r.sim.writes.at(-1)!.reg, REG.OPTIONS); assert.equal(r.sim.writes.at(-1)!.data.length, 2);
  assert.ok(r.svc.link.sent.every((x) => x.kind !== "data")); assert.equal(r.sim.swallowed.length, 0);                                           // nothing but AF AF frames reached the unit
});
test("RSSI is shown as the unit's two raw numbers, never as dBm", async () => {
  const r = await rig(); const res = await r.svc.readFromUnit(A); assert.deepEqual(res.params.rssi, { env: 95, packet: 80 });
  const page = readFileSync("web/src/A100Page.tsx", "utf8"); for (const line of page.split("\n").filter((l) => /SIGNAL|rssi\./.test(l))) assert.ok(!/\bdBm\b/.test(line), "no dBm next to the signal: " + line.slice(0, 80)); assert.match(page, /RAW/);
});

test("a command is SENT when written to the A100 with the target prefix, then UNKNOWN without feedback; never CONFIRMED by the radio", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const d = withPayload(r); const res = await r.svc.command({ username: "op1", role: "operator" }, d.id, "on");
  assert.equal(res.status, "SENT"); await new Promise((x) => setTimeout(x, 100)); assert.equal(hex(r.sim.swallowed.at(-1)!), "01 07 09 a1 b2 c3");        // address high, address low, channel, then the payload
  assert.equal(r.svc.commands()[0].status, "SENT"); assert.equal(r.svc.sweep(Date.now() + 5_000), 0); assert.equal(r.svc.sweep(Date.now() + 31_000), 1);
  assert.equal(r.svc.commands()[0].status, "UNKNOWN"); assert.notEqual(r.svc.commands()[0].status, "CONFIRMED");
  const row = r.audits().find((a) => a.action === "a100.command")!; assert.match(row.detail, /"command":"on"/);
});
test("CONFIRMED only through the feedback hook, which nothing in the app calls yet", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const d = withPayload(r); const { id } = await r.svc.command(A, d.id, "on"); r.svc.sweep(Date.now() + 31_000);
  const callers = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && f !== join("a100", "service.ts")).filter((f) => /confirmFromFeedback/.test(readFileSync(join("src", f), "utf8")));
  assert.deepEqual(callers, []);                                                                                              // nothing in the app calls it: no feedback protocol yet
  r.svc.confirmFromFeedback(id); assert.equal(r.svc.commands()[0].status, "CONFIRMED");
});
test("transparent mode sends the payload alone; master-slave is refused", async () => {
  const r = await rig(); r.sim.regs.set(REG.MODE, Buffer.from([0, 1])); await r.svc.readFromUnit(A); const d = withPayload(r, "feed"); await r.svc.command(A, d.id, "on"); await new Promise((x) => setTimeout(x, 100)); assert.equal(hex(r.sim.swallowed.at(-1)!), "fe ed");
  const d2 = withPayload(r, "beef", { name: "Second" }); r.sim.regs.set(REG.MODE, Buffer.from([0, 4])); await r.svc.readFromUnit(A); await assert.rejects(r.svc.command(A, d2.id, "off"), /not supported/);
});
test("rate limit per device (default 10 s), no payload and an unanswering link are refused with a sentence", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const d = withPayload(r); let t = Date.now(); r.svc.now = () => t;
  await r.svc.command(A, d.id, "on"); await assert.rejects(r.svc.command(A, d.id, "off"), /at most one command every 10 s/); t += 11_000; r.svc.link; (r.db.prepare("UPDATE a100_link SET answered_at=?").run(t)); await r.svc.command(A, d.id, "off");
  const bare = r.svc.saveDevice(A, null, { name: "No payload yet", kind: "fan" }); await assert.rejects(r.svc.command(A, bare.id, "on"), /no command payload/);
  t += 400_000; await assert.rejects(r.svc.command(A, d.id, "on"), /not answering/);                          // link silent for over 2 minutes: UNKNOWN, commands disabled
  assert.equal(r.svc.devices().find((x) => x.id === d.id)!.state, "UNKNOWN");
});
test("devices behind the link: add, edit, remove, audited; payloads must be hex", async () => {
  const r = await rig(); const d = withPayload(r); assert.equal(d.destAddr, 7); const e = r.svc.saveDevice(A, d.id, { name: "Fan 1", rate_limit_s: 30 }); assert.equal(e.name, "Fan 1"); assert.equal(e.rateLimitS, 30);
  assert.throws(() => r.svc.saveDevice(A, null, { name: "x", payloads: { on: "zz" } }), /hex/); assert.throws(() => r.svc.saveDevice(A, null, { name: "x", dest_addr: 300 }), /destination address/);
  r.svc.deleteDevice(A, d.id); assert.equal(r.svc.devices().length, 0); assert.deepEqual(r.audits().map((a) => a.action).filter((a) => a.startsWith("a100.device")), ["a100.device.add", "a100.device.update", "a100.device.remove"]);
});

test("API: Operator gets 403 on every A100 route, Admin works, the page is open on FREE, CONTROL shows the devices without radio details", async () => {
  const r = await rig(); await r.svc.readFromUnit(A); const d = withPayload(r); const ing = new Ingest(r.db);
  const { app } = await buildApp(r.db, ing, new Commands(r.db, { publish() {} } as any, () => {}), null, null, null, r.pm, null, { a100: r.svc }); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => { void app.close(); });
  const hp = (app.server.address() as AddressInfo).port, mk = (n: string, role: string) => { const id = Number(r.db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(n, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return "core_session=" + createSession(r.db, id); };
  const ac = mk("adm", "admin"), oc = mk("op", "operator"); const call = async (c: string, m: string, u: string, b?: unknown) => { const x = await fetch(`http://127.0.0.1:${hp}${u}`, { method: m, headers: m === "GET" || m === "DELETE" ? { cookie: c } : { cookie: c, "content-type": "application/json" }, body: m === "GET" || m === "DELETE" ? undefined : JSON.stringify(b ?? {}) }); const t = await x.text(); return { status: x.status, t }; };
  const routes = [["GET", "/api/a100"], ["PUT", "/api/a100/link", {}], ["POST", "/api/a100/read"], ["POST", "/api/a100/test"], ["POST", "/api/a100/write", {}], ["POST", "/api/a100/revert", {}], ["POST", "/api/a100/key", {}], ["POST", "/api/a100/reset", {}], ["POST", "/api/a100/devices", {}], ["PUT", "/api/a100/devices/999", {}], ["DELETE", "/api/a100/devices/999"]] as const;
  for (const [m, u, b] of routes) { assert.equal((await call(oc, m, u, b)).status, 403, `Operator ${m} ${u}`); assert.notEqual((await call(ac, m, u, b)).status, 403, `Admin ${m} ${u}`); }
  const v = await call(ac, "GET", "/api/a100"); assert.equal(v.status, 200); assert.ok(!v.t.includes("ashining.com"));                    // FREE licence (no licence passed): still open
  const c = await call(oc, "GET", "/api/control"); const dev = JSON.parse(c.t).devices.find((x: any) => x.name === "Test receiver"); assert.ok(dev, c.t); assert.equal(dev.kind, "fan"); assert.equal(dev.linkState, "UNKNOWN"); assert.deepEqual(dev.capabilities, []);
  for (const k of ["destAddr", "destGroup", "channel", "payloads", "port"]) assert.ok(!(k in dev), k); assert.ok(!c.t.includes("a1b2c3"));
  const cmd = await call(oc, "POST", `/api/control/a100/${d.id}/command`, { command: "on" }); assert.equal(cmd.status, 200); assert.equal(JSON.parse(cmd.t).status, "SENT");   // an Operator commands from CONTROL, as for the pump
});

test("the menu has the group CONTROL DEVICES between DATA SOURCES and SYSTEM with Ashining A100: Admin only (shared GROUPS block, also the phone MORE sheet), not licence gated", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8");
  const g = sb.slice(sb.indexOf("export const GROUPS"), sb.indexOf("export const TABS")), pos = (t: string) => g.indexOf(`title: "${t}"`);
  assert.ok(pos("Data sources") > 0 && pos("Control devices") > pos("Data sources") && pos("System") > pos("Control devices"), "group order"); assert.match(g, /\["ashining-a100", "ASHINING A100"\]/);
  assert.match(sb, /\{admin && GROUPS\.filter/); assert.match(ab, /\{admin && GROUPS\.filter/);                    // sidebar, tablet drawer and the phone MORE sheet all read GROUPS, Admin only
  assert.match(st, /t === "ashining-a100" \? <A100Page \/>/);
  const badge = sb.slice(sb.indexOf("export function useBadges"), sb.indexOf("Persistent left sidebar")); assert.ok(!/a100/i.test(badge), "no licence lock badge for the A100 item");
  assert.ok(!/a100/i.test(readFileSync("src/licence/dataSources.ts", "utf8")) && !/a100/i.test(readFileSync("src/licence/usage.ts", "utf8")), "not licence gated, not counted as a data source");
});
