import "./isolate.js";
// 2026-11-17 -- Windows lab (tablet, COM11 / CH340, build 9fb957e): Ports page said OPEN with 0 / 0, the Gateway page said "(switched off)" and NO GATEWAY, TEST PORT showed nothing,
// SAVE said "reopened and tested" although nothing was. Everything below runs against a FAKE serial line (test/fakeSerial.ts) that, like Windows, allows ONE handle per COM port.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { setSerialModuleForTests } from "../src/drivers/modbus/transport.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";
import { PortStore } from "../src/ports/store.js"; import { PortManager, summarize } from "../src/ports/manager.js"; import { resetSerialCacheForTests } from "../src/ports/available.js";
// @ts-ignore plain .mjs without types
import { runProbe, bareName, crc16 } from "../deploy/windows/serial-probe.mjs";
import { FakeLine, asWindows, captureConsole } from "./fakeSerial.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" };
const env = { transport: "off" as const, host: "127.0.0.1", port: 5020, serialPath: "COM3", baud: 9600, parity: "none" as const, address: 0, timeoutMs: 1500, retries: 2 };   // GW_TRANSPORT unset = the lab's fresh database
const closers: (() => Promise<void> | void)[] = []; after(async () => { for (const c of closers) await c(); setSerialModuleForTests(null); });
const FORM = { enabled: true, transport: "serial", device_path: "COM11", baud: 9600, parity: "none", stop_bits: 1, timeout_ms: 150, retries: 0, turnaround_ms: 0 };   // what the page sends after: pick COM11, SAVE

/** A fresh lab database (GW_TRANSPORT off), a fake line with a gateway simulator on it, the manager started. */
async function lab() {
  resetSerialCacheForTests(); const line = new FakeLine(); const gsim = new GatewaySim(map); line.slave = (u, pdu) => gsim.handle(u, pdu); setSerialModuleForTests(line.module);
  const db = openDb(":memory:"), store = new PortStore(db); store.migrateFromEnv(env, map.default_gateway_address);
  const reg = new Registry(db, map), gw = new GatewayService(db, reg, new Ingest(db), null); gw.start(); const mgr = new PortManager(db, store, map, gw); await mgr.start();
  closers.push(async () => { await mgr.stop(); await gw.stop(); }); return { line, gsim, db, store, gw, mgr };
}
const gwDev = (s: PortStore) => s.devices().find((d) => d.kind === "lora_gateway")!;

test("CAUSE: a fresh database seeds the gateway DEVICE enabled even when the port is off (it was seeded OFF and the page had no switch for it); repair switches old rows on exactly once", async () => {
  const { store, db } = await lab(); assert.equal(store.port(1)!.enabled, false); assert.equal(gwDev(store).enabled, true, "the PORT is the switch, the device row starts ON");
  db.prepare("UPDATE bus_devices SET enabled=0").run(); db.prepare("DELETE FROM settings WHERE key='bus_devices_on_by_default'").run();   // a database made by the 9fb957e build
  assert.equal(store.repairDeviceFlags(), 2); assert.ok(store.devices().every((d) => d.enabled)); assert.equal(store.repairDeviceFlags(), 0);
  db.prepare("UPDATE bus_devices SET enabled=0 WHERE kind='weather'").run(); assert.equal(store.repairDeviceFlags(), 0, "a later, deliberate OFF is never undone");
});

test("fresh database -> choose COM11 + SAVE -> the poller really opens COM11 (bare name), requests start, the gateway goes ONLINE, every lamp agrees", async () => {
  await asWindows(async () => {
    const { line, store, gw, mgr } = await lab();
    assert.equal(mgr.portView(store.port(1)!).status, "CLOSED"); assert.equal(mgr.gatewayLink()!.enabled, false); assert.equal(mgr.gatewayLink()!.portEnabled, false);
    const { result: r, log } = await captureConsole(() => mgr.applyPort(A, 1, FORM));
    assert.equal(r.pending, null); assert.equal(r.summary.tone, "ok", r.summary.text); assert.match(r.summary.text, /^Saved\. The port was reopened and tested: .*OK, \d+ ms/); assert.deepEqual(line.opened, ["COM11"], "opened as the bare name; serialport adds \\\\.\\ itself");
    assert.ok(log.some((l) => /INFO serial: opening COM11 \(OS path \\\\\.\\COM11\) 9600 8N1/.test(l)), log.join("\n")); assert.ok(log.some((l) => /INFO serial: opened COM11/.test(l)));
    await gw.pollNow(); const pv = mgr.portView(store.port(1)!); assert.equal(pv.status, "OPEN"); assert.ok(pv.counters.requests > 0, "requests started"); assert.equal(pv.notPolled, false);
    assert.equal(gw.online, true); assert.equal(mgr.deviceState(gwDev(store)), "online"); const link = mgr.gatewayLink()!; assert.equal(link.enabled, true); assert.equal(link.line, "9600 8N1"); assert.equal(link.serialPath, "COM11");
    assert.equal(mgr.view().devices.find((d) => d.kind === "lora_gateway")!.state, "online"); assert.equal(line.tx.length > 0, true);
  });
});

test("the lab's database (gateway device OFF, port ON): the port is really open but NOT POLLED after 60 s, TEST says SWITCHED OFF in plain words, the repair fixes it", async () => {
  await asWindows(async () => {
    const { line, db, store, mgr } = await lab(); db.prepare("UPDATE bus_devices SET enabled=0").run();
    await mgr.applyPort(A, 1, FORM); const p = store.port(1)!; assert.deepEqual(line.opened, ["COM11"]);
    const early = mgr.portView(p, Date.now() + 10_000), late = mgr.portView(p, Date.now() + 61_000);
    assert.equal(early.status, "OPEN"); assert.equal(early.notPolled, false); assert.equal(late.status, "OPEN"); assert.equal(late.notPolled, true); assert.match(late.lastError!, /OPEN, but no request has been sent/); assert.match(late.lastError!, /Enabled/);
    assert.equal(mgr.gatewayLink()!.enabled, false); assert.equal(mgr.gatewayLink()!.portEnabled, true); assert.equal(mgr.gatewayLink()!.deviceEnabled, false);
    const t = await mgr.test(1); assert.equal(t.results[0].result, "off"); assert.match(t.results[0].detail!, /device is switched off/); assert.equal(t.summary.tone, "warn"); assert.match(t.summary.text, /SWITCHED OFF/);
    store.repairDeviceFlags(); db.prepare("DELETE FROM settings WHERE key='bus_devices_on_by_default'").run(); db.prepare("UPDATE bus_devices SET enabled=0").run(); assert.equal(store.repairDeviceFlags(), 2);
    await mgr.applyDevice(A, gwDev(store).id, { poll_interval_s: 31 }); assert.equal((await mgr.test(1)).results[0].result, "ok");
    assert.equal(summarize("save", [], { portOn: true, openText: "COM11 is open" }).tone, "warn", "an open port with nothing assigned is never reported as tested");
  });
});

test("OPEN is a real handle: access denied (vendor tool holds COM11) shows ACCESS DENIED with the OS text and is logged as ERROR; file not found shows NOT FOUND; freeing the port recovers", async () => {
  await asWindows(async () => {
    const { line, store, mgr } = await lab(); line.held.add("COM11");                              // the vendor tool has the port
    const { result: r, err } = await captureConsole(() => mgr.applyPort(A, 1, FORM));
    const pv = mgr.portView(store.port(1)!); assert.equal(pv.status, "ACCESS DENIED"); assert.match(pv.lastError!, /Access denied/); assert.match(pv.lastError!, /OS error/); assert.match(pv.lastError!, /another program has it open/);
    assert.equal(r.summary.tone, "err"); assert.match(r.summary.text, /^Saved, but the test did not pass: .*CANNOT OPEN: could not open COM11: Opening COM11: Access denied/); assert.ok(err.some((l) => /ERROR serial: could not open COM11: Opening COM11: Access denied/.test(l)), err.join("\n"));
    const t = await mgr.test(1); assert.equal(t.results[0].result, "open_error"); assert.match(t.summary.text, /could not open COM11/);
    line.held.delete("COM11"); const ok = await mgr.test(1); assert.equal(ok.results[0].result, "ok"); assert.equal(mgr.portView(store.port(1)!).status, "OPEN");
    line.openError.set("COM11", { message: "Opening COM11: File not found" }); await mgr.applyPort(A, 1, { baud: 19200 }); assert.equal(mgr.portView(store.port(1)!).status, "NOT FOUND"); assert.match(mgr.portView(store.port(1)!).lastError!, /not found/i);
    line.openError.set("COM11", { message: "Opening COM11: Unknown error code 31" }); await mgr.applyPort(A, 1, { baud: 9600 }); assert.equal(mgr.portView(store.port(1)!).status, "ERROR"); assert.match(mgr.portView(store.port(1)!).lastError!, /Unknown error code 31/);
  });
});

test("unplugging the adapter closes the handle: NOT OPEN with the reason, the next request reopens it", async () => {
  await asWindows(async () => {
    const { line, store, mgr } = await lab(); await mgr.applyPort(A, 1, FORM); const q = (mgr as any).queues.get(1); assert.equal(mgr.portView(store.port(1)!).status, "OPEN");
    const { result: log } = await captureConsole(async () => { (q.tr as any).ch.port.unplug(); return 1; }); void log;
    const pv = mgr.portView(store.port(1)!); assert.equal(pv.status, "NOT OPEN"); assert.match(pv.lastError!, /closed/); assert.equal((await mgr.test(1)).results[0].result, "ok"); assert.equal(mgr.portView(store.port(1)!).status, "OPEN"); assert.equal(line.opened.length, 2);
  });
});

test("TEST PORT always answers with a result and a sentence: switched off, cannot open, NO ANSWER, CRC ERROR, OK with response time, nothing assigned", async () => {
  await asWindows(async () => {
    const { line, store, mgr } = await lab();
    const off = await mgr.test(1); assert.equal(off.results[0].result, "off"); assert.match(off.results[0].detail!, /port is switched off/); assert.equal(off.summary.tone, "warn"); assert.match(off.summary.text, /SWITCHED OFF: port is switched off/);
    await mgr.applyPort(A, 1, FORM); const ok = await mgr.test(1); assert.equal(ok.results[0].result, "ok"); assert.ok(ok.results[0].ms! >= 0); assert.match(ok.summary.text, /^Tested the saved settings: XZ-DS-MUS2 \(address 7\) OK, \d+ ms\.$/);
    line.mode = "silent"; const na = await mgr.test(1); assert.equal(na.results[0].result, "no_answer"); assert.equal(na.summary.tone, "err"); assert.match(na.summary.text, /NO ANSWER/);
    line.mode = "badcrc"; const crc = await mgr.test(1); assert.equal(crc.results[0].result, "crc_error"); assert.match(crc.summary.text, /CRC ERROR/); line.mode = "ok";
    store.saveDevice({ ...gwDev(store), port_id: 2 }); await (mgr as any).bind(); const none = await mgr.test(1); assert.deepEqual(none.results.map((r) => r.result), []); assert.equal(none.summary.tone, "warn"); assert.match(none.summary.text, /No device is assigned/); assert.match(none.summary.text, /COM11 is open/);
    line.openError.set("COM11", { message: "Opening COM11: Access denied" }); await (mgr as any).build(store.port(1)!, true); const bad = await mgr.test(1); assert.equal(bad.results[0].result, "open_error"); assert.match(bad.results[0].detail!, /could not open COM11/); assert.equal(bad.summary.tone, "err");
  });
});

test("TEST PORT on UNSAVED form settings: says so, releases the live handle first (one handle per COM), restores the saved settings and keeps polling; invalid and switched-off drafts still answer", async () => {
  await asWindows(async () => {
    const { line, store, gw, mgr } = await lab(); await mgr.applyPort(A, 1, FORM); await gw.pollNow(); const dev = gwDev(store);
    const good = await mgr.test(1, { port: { ...FORM, baud: 9600 }, devices: { [dev.id]: { modbus_address: 7, enabled: true } } }); assert.equal(good.usedDraft, false, "same as saved = the live line"); const before = mgr.portView(store.port(1)!).counters.requests;
    const wrong = await mgr.test(1, { port: FORM, devices: { [dev.id]: { modbus_address: 9, poll_interval_s: 30, enabled: true } } });
    assert.equal(wrong.usedDraft, true); assert.equal(wrong.saved, false); assert.equal(wrong.results[0].result, "no_answer"); assert.match(wrong.summary.text, /^Tested the settings shown in the form \(NOT saved yet\): .*NO ANSWER/); assert.equal(gwDev(store).modbus_address, 7, "nothing was stored");
    const right = await mgr.test(1, { port: { ...FORM, baud: 19200 }, devices: { [dev.id]: { modbus_address: 7 } } }); assert.equal(right.results[0].result, "ok"); assert.match(right.summary.text, /NOT saved yet/); assert.equal(store.port(1)!.baud, 9600);
    assert.equal(line.held.has("COM11"), true, "the live line is open again afterwards"); assert.equal(mgr.portView(store.port(1)!).status, "OPEN"); assert.equal(mgr.portView(store.port(1)!).counters.requests, before, "counters are not reset by a draft test");
    await gw.pollNow(); assert.equal(gw.online, true); assert.equal(gw.paused, false);
    const inv = await mgr.test(1, { port: { baud: 12345 } }); assert.equal(inv.results[0].result, "invalid"); assert.match(inv.results[0].detail!, /baud/); assert.equal(inv.summary.tone, "err");
    const off = await mgr.test(1, { port: { enabled: false } }); assert.equal(off.results[0].result, "off"); assert.match(off.summary.text, /SWITCHED OFF/); assert.match(off.summary.text, /NOT saved yet/);
    line.openError.set("COM12", { message: "Opening COM12: File not found" }); const other = await mgr.test(1, { port: { device_path: "COM12" } }); assert.match(other.results[0].detail!, /could not open COM12: Opening COM12: File not found/); assert.equal(other.results[0].result, "open_error", "a COM port that does not exist: the OS error is shown, nothing is silently skipped"); void other;
  });
});

test("SAVE message follows the real test: never 'tested' when the device was off, silent or the port could not be opened", async () => {
  await asWindows(async () => {
    const { line, db, store, mgr } = await lab(); line.mode = "silent"; const r = await mgr.applyPort(A, 1, FORM);
    assert.equal(r.summary.tone, "err"); assert.match(r.summary.text, /^Saved, but the test did not pass: .*NO ANSWER/); assert.doesNotMatch(r.summary.text, /reopened and tested/);
    db.prepare("UPDATE bus_devices SET enabled=0").run(); const r2 = await mgr.applyPort(A, 1, { baud: 19200 }); assert.equal(r2.summary.tone, "warn"); assert.match(r2.summary.text, /SWITCHED OFF/); assert.doesNotMatch(r2.summary.text, /reopened and tested/);
    assert.equal((await mgr.applyPort(A, 1, { baud: 19200 })).summary.text, "Nothing changed."); assert.equal(store.port(1)!.baud, 19200);
    const r3 = await mgr.applyPort(A, 1, { enabled: false }); assert.match(r3.summary.text, /switched off/);
  });
});

test("serial logging: open / close / errors always at INFO or ERROR on the console; hex TX / RX frames only with LOG_MODBUS=1", async () => {
  await asWindows(async () => {
    const { store, mgr } = await lab(); delete process.env.LOG_MODBUS;
    const quiet = await captureConsole(async () => { await mgr.applyPort(A, 1, FORM); await mgr.test(1); }); assert.ok(quiet.log.some((l) => /INFO serial: opened COM11/.test(l))); assert.equal(quiet.log.filter((l) => /modbus (TX|RX)/.test(l)).length, 0);
    process.env.LOG_MODBUS = "1"; try {
      const loud = await captureConsole(async () => { await mgr.test(1); }); const tx = loud.log.find((l) => /INFO modbus TX COM11/.test(l)), rx = loud.log.find((l) => /INFO modbus RX COM11/.test(l)); assert.ok(tx && rx, loud.log.join("\n"));
      assert.match(tx!, /TX COM11 8B 07 04 00 00 00 01 [0-9a-f]{2} [0-9a-f]{2}$/); assert.match(rx!, /^\S+ INFO modbus RX COM11 \d+B 07 04 02 /);
    } finally { delete process.env.LOG_MODBUS; }
    const closing = await captureConsole(async () => { await mgr.applyPort(A, 1, { enabled: false }); }); assert.ok(closing.log.some((l) => /INFO serial: closing COM11/.test(l)), closing.log.join("\n")); void store;
  });
});

// ---------- the standalone probe (serial-probe.cmd) ----------
function probeLine(over: Partial<FakeLine> = {}) {
  const line = new FakeLine(); Object.assign(line, over); const regs = new Array(120).fill(0xffff); [112600317, 112600316].forEach((s, i) => { regs[i * 4] = s >>> 16; regs[i * 4 + 1] = s & 0xffff; regs[i * 4 + 2] = 5; regs[i * 4 + 3] = 0; });
  line.slave = (unit, pdu) => { if (unit !== 7 || pdu[0] !== 4) return null; const addr = pdu.readUInt16BE(1), n = pdu.readUInt16BE(3); const vals = addr === 1 ? [300] : addr === 0x100 ? regs.slice(0, n) : []; if (!vals.length) return null; const b = Buffer.alloc(2 + vals.length * 2); b[0] = 4; b[1] = vals.length * 2; vals.forEach((v, i) => b.writeUInt16BE(v, 2 + i * 2)); return b; };
  return line;
}
const probe = async (line: FakeLine, args: string[]) => { const out: string[] = []; const r = await runProbe({ args, SerialPort: line.module.SerialPort, out: (l: string) => out.push(l), sleep: (ms: number) => new Promise((x) => setTimeout(x, Math.min(ms, 5))), timeoutMs: 120 }); return { r, text: out.join("\n") }; };

test("serial-probe: lists ports, opens COM11 bare, prints TX/RX hex with time stamps, decodes PID and serials, PASS, closes the port", async () => {
  const line = probeLine(); const { r, text } = await probe(line, ["\\\\.\\com11", "7", "9600"]);
  assert.equal(r.pass, true); assert.deepEqual(line.opened, ["COM11"]); assert.deepEqual(line.closed, ["COM11"]); assert.equal(line.held.size, 0);
  assert.match(text, /1\) COM ports[\s\S]*COM11 {3}USB-SERIAL CH340 \(COM11\) {3}VID:PID 1A86:7523/); assert.match(text, /2\) Opening COM11 \(the operating system sees it as \\\\\.\\COM11\) at 9600 8N1[\s\S]*opened OK/);
  assert.match(text, /\[\d\d:\d\d:\d\d\.\d{3}\] TX \(try 1\/3\) 00 04 00 00 00 00 [0-9a-f]{2} [0-9a-f]{2}/); assert.match(text, /3\) .*broadcast ID 00, FC04, address 0, count 0/);
  assert.match(text, /TX \(try 1\/3\) 07 04 00 01 00 01 [0-9a-f]{2} [0-9a-f]{2}\n.*RX 07 04 02 01 2c /); assert.match(text, /value = 300 \(0x012c\)/);
  assert.match(text, /TX \(try 1\/3\) 07 04 01 00 00 78 /); assert.match(text, /120 registers came back/); assert.match(text, /slot {2}1: serial 112600317 \(0x06b624fd\) {3}interval 5 min/); assert.match(text, /slot {2}2: serial 112600316/); assert.match(text, /slot {2}3: \(empty\)/);
  assert.match(text, /COM11 closed\nPASS: gateway answered$/);
  assert.equal(crc16(Buffer.from([1, 3, 0, 0, 0, 1])), 0x0a84); assert.equal(bareName("COM011"), "COM11"); assert.equal(bareName("/dev/ttyUSB0"), "/dev/ttyUSB0");
});
test("serial-probe: FAIL with the try count when nobody answers; the exact OS error when the port cannot be opened; usage without a port", async () => {
  const silent = probeLine({ mode: "silent" }); const f = await probe(silent, ["COM11", "7"]); assert.equal(f.r.pass, false); assert.match(f.text, /no answer within 120 ms/); assert.match(f.text, /FAIL: no answer after 9 tries, check wiring A\/B/); assert.deepEqual(silent.closed, ["COM11"]);
  const busy = probeLine(); busy.held.add("COM11"); const b = await probe(busy, ["COM11"]); assert.equal(b.r.pass, false); assert.equal(b.r.opened, false); assert.match(b.text, /FAILED to open COM11: Opening COM11: Access denied/); assert.match(b.text, /another program has the port open/); assert.match(b.text, /FAIL: the port could not be opened/);
  const gone = probeLine(); gone.openError.set("COM11", { message: "Opening COM11: File not found", code: "ENOENT" }); const g = await probe(gone, ["COM11"]); assert.match(g.text, /FAILED to open COM11: Opening COM11: File not found \(ENOENT\)/); assert.match(g.text, /no such COM port/);
  const u = await probe(probeLine(), []); assert.equal(u.r.usage, true); assert.match(u.text, /Usage: serial-probe\.cmd COM11 \[address=7\] \[baud=9600\]/);
  const bad = probeLine({ mode: "badcrc" }); assert.match((await probe(bad, ["COM11"])).text, /bad CRC/);
});
