import "./isolate.js";
// 2026-11-17 -- Windows lab (tablet, COM11, real XZ-DS-MUS2 address 7): the poller ran and TEST PORT was OK, but the gateway went OFFLINE with "short or wrong-sized read response"
// (12 of 14 requests failed) while serial-probe.cmd passed: a 120-register reply is 245 bytes and the USB adapter hands it over in about 8 bursts with 20-60 ms gaps.
// The RTU reader must read until the KNOWN length (5 + 2*count) has arrived, never end a frame on silence, drop stray bytes, retry on a bad CRC or a short reply and say why.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net";
import { createTransport, setSerialModuleForTests } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js";
import { readRespPdu } from "../src/drivers/modbus/frames.js"; import { matchRtuResponse } from "../src/drivers/modbus/transport.js"; import { rtuWrap, readPdu } from "../src/drivers/modbus/frames.js";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { Commands } from "../src/commands.js"; import { buildApp } from "../src/app.js"; import { hashPassword, createSession } from "../src/auth.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";
import { PortStore } from "../src/ports/store.js"; import { PortManager } from "../src/ports/manager.js";
import { FakeLine, captureConsole } from "./fakeSerial.js";

after(() => setSerialModuleForTests(null));
const REGS = Array.from({ length: 120 }, (_, i) => (i * 257 + 11) & 0xffff);
function setup(timeoutMs = 1500, retries = 2) {
  const line = new FakeLine(); line.slave = (_u, pdu) => (pdu[0] === 4 ? readRespPdu(4, REGS.slice(0, pdu.readUInt16BE(3))) : null); setSerialModuleForTests(line.module);
  const tr = createTransport({ type: "rtu-serial", path: "COM11", baud: 9600 }); const m = new ModbusMaster(tr, { unit: 7, timeoutMs, retries });
  return { line, m, tr, done: () => tr.close() };
}

test("a 245-byte reply delivered in 8 bursts with 20-60 ms gaps is ONE good reply: no retry, no error", async () => {
  const { line, m, done } = setup(); line.burst = { n: 8, gapMin: 20, gapMax: 60 };
  const got = await m.read(4, 0x0100, 120); assert.deepEqual(got, REGS); assert.equal(line.chunks.length, 8, "really arrived in 8 bursts"); assert.equal(line.chunks.reduce((a, b) => a + b, 0), 245);
  assert.equal(line.tx.length, 1, "one request, no retry"); assert.equal(m.queue.stats.errors, 0); assert.equal(m.queue.stats.requests, 1); await done();
});

test("one corrupted byte (ff -> 47 in the lab): the frame is NOT accepted, bad CRC is the reason, the retry succeeds", async () => {
  const { line, m, done } = setup(); line.burst = { n: 8, gapMin: 20, gapMax: 40 }; line.corrupt = 1;
  const got = await m.read(4, 0x0100, 120); assert.deepEqual(got, REGS); assert.equal(line.tx.length, 2, "request sent twice"); assert.equal(m.queue.stats.requests, 2); assert.equal(m.queue.stats.errors, 1);
  assert.match(m.queue.stats.lastError!, /bad CRC \(245 bytes received, 245 expected\)/); assert.equal(m.queue.tr.badFrames!(), 1); await done();
});

test("a truncated reply: every retry fails with 'short reply: got N of M bytes', nothing partial is ever returned; a truncation that happens once is retried and succeeds", async () => {
  { const { line, m, done } = setup(400, 2); line.truncate = { times: 99, cut: 20 }; await assert.rejects(() => m.read(4, 0x0100, 120), /short reply: got 225 of 245 bytes/); assert.equal(line.tx.length, 3, "1 try + 2 retries"); assert.equal(m.queue.stats.errors, 3); await done(); }
  { const { line, m, done } = setup(400, 2); line.truncate = { times: 1, cut: 100 }; assert.deepEqual(await m.read(4, 0x0100, 120), REGS); assert.equal(line.tx.length, 2); assert.match(m.queue.stats.lastError!, /short reply: got 145 of 245 bytes/); await done(); }
});

test("no answer at all says 'timeout: no reply'; stray bytes in front of the reply (also one that looks like the start of a frame) are discarded", async () => {
  { const { line, m, done } = setup(200, 1); line.mode = "silent"; await assert.rejects(() => m.read(4, 1, 1), /timeout: no reply within 200 ms/); assert.equal(line.tx.length, 2); await done(); }
  { const { line, m, done } = setup(); line.stray = [0xff, 0x07, 0x04, 0x01, 0x00]; line.burst = { n: 3, gapMin: 10, gapMax: 20 }; assert.deepEqual(await m.read(4, 0x0100, 120), REGS); assert.equal(line.tx.length, 1); await done(); }
});

test("matcher: wrong unit / wrong function code is ignored (not an error), exception reply is 5 bytes, bad CRC is never accepted, a short frame waits", () => {
  const pdu = readPdu(4, 1, 2), good = rtuWrap(7, readRespPdu(4, [0x1234, 0x5678]));
  assert.deepEqual(matchRtuResponse(good, 7, pdu), readRespPdu(4, [0x1234, 0x5678])); assert.equal(matchRtuResponse(rtuWrap(8, readRespPdu(4, [1, 2])), 7, pdu), null, "another unit's reply is not ours");
  assert.equal(matchRtuResponse(rtuWrap(7, readRespPdu(3, [1, 2])), 7, pdu), null, "another function code");
  assert.deepEqual(matchRtuResponse(rtuWrap(7, Buffer.from([0x84, 2])), 7, pdu), Buffer.from([0x84, 2]));
  assert.equal(matchRtuResponse(good.subarray(0, 6), 7, pdu), null, "short: keep reading"); const bad = Buffer.from(good); bad[4] ^= 1; assert.deepEqual(matchRtuResponse(bad, 7, pdu), { fail: "bad CRC (9 bytes received, 9 expected)" });
  assert.deepEqual(matchRtuResponse(Buffer.concat([Buffer.from([0, 0, 0]), good]), 7, pdu), readRespPdu(4, [0x1234, 0x5678]), "leading stray bytes");
});

test("LOG_MODBUS=1: every TX and RX has a timestamp and a byte count, and the decision (frame ok / rejected / short reply) is logged; off by default", async () => {
  process.env.LOG_MODBUS = "1"; try {
    const { line, m, done } = setup(300, 0); line.burst = { n: 4, gapMin: 5, gapMax: 10 };
    const { log } = await captureConsole(async () => { await m.read(4, 0x0100, 120); line.truncate = { times: 1, cut: 10 }; await m.read(4, 0x0100, 120).catch(() => {}); });
    const tx = log.filter((l) => / modbus TX COM11 8B /.test(l)), rx = log.filter((l) => / modbus RX COM11 \d+B /.test(l)); assert.equal(tx.length, 2); assert.equal(rx.length, 8); assert.ok(log.every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)));
    assert.ok(log.some((l) => /modbus frame ok unit 7 fc 4 245B in \d+ ms/.test(l))); assert.ok(log.some((l) => /modbus short reply: got 235 of 245 bytes/.test(l))); await done();
  } finally { delete process.env.LOG_MODBUS; }
});

test("gateway: one failed cycle does not make it OFFLINE (only offlineCycles failed cycles in a row), lastError carries the real reason; the GATEWAY card address falls back to the configured one while no poll has succeeded", async () => {
  const map = loadRegMap("config/gateway-thingsend.yaml"); const line = new FakeLine(); setSerialModuleForTests(line.module); line.mode = "silent";
  const db = openDb(":memory:"), store = new PortStore(db); store.migrateFromEnv({ transport: "off", host: "127.0.0.1", port: 5020, serialPath: "COM3", baud: 9600, parity: "none", address: 0, timeoutMs: 100, retries: 0 }, map.default_gateway_address);
  db.prepare("UPDATE bus_devices SET modbus_address=7 WHERE kind='lora_gateway'").run(); store.savePort({ ...store.port(1)!, enabled: true, transport: "serial", device_path: "COM11", timeout_ms: 100, retries: 0, turnaround_ms: 0 }, "t");
  const reg = new Registry(db, map), gw = new GatewayService(db, reg, new Ingest(db), null); const mgr = new PortManager(db, store, map, gw); await mgr.start(); after(async () => { await mgr.stop(); await gw.stop(); });
  assert.ok(gw.drv, "driver bound"); gw.online = true; await gw.pollNow(); assert.equal(gw.failCycles, 1); assert.equal(gw.online, true, "one failed cycle: still online"); assert.match(gw.lastError!, /timeout: no reply within 100 ms/);
  await gw.pollNow(); await gw.pollNow(); assert.equal(gw.online, false, "3 failed cycles in a row");
  const { app } = await (buildApp as any)(db, new Ingest(db), new Commands(db, { publish() {} } as any, () => {}), reg, gw, null, mgr); await app.listen({ port: 0, host: "127.0.0.1" }); after(() => void app.close());
  const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run("a", hashPassword("x".repeat(10)), "admin", 1).lastInsertRowid); const cookie = "core_session=" + createSession(db, id);
  const g = await (await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/gateway`, { headers: { cookie } })).json() as any;
  assert.equal(g.link.address, 7); assert.equal(g.info.address, 7, "GATEWAY card shows the address while offline"); assert.match(g.lastError, /timeout/);
});
