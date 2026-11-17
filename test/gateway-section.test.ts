import "./isolate.js";
// 2026-11-18 -- brought into the release branch WITHOUT the Windows serial transport: the three serial-only tests (burst reads, short-reply text, bad-CRC retry) stay on the windows-port branch; the rest runs over TCP.
// 2026-11-17 -- Windows lab, real XZ-DS-MUS2 (address 7). Two things, both over the fake serial port (rtu frames, CRC, bursts):
//   (1) the system area (FC04 0x0000 address, 0x0001 PID, 0x0002 version) answers ONE register per read. A count-3 request got a 7-byte reply, the reader waited for 11 bytes and the gateway went OFFLINE.
//       Now every system register is its own count-1 read, the version is optional and the system registers never decide ONLINE (the config / data poll does).
//   (2) READ GATEWAY T/H SECTION / READ GATEWAY SOIL SECTION: read-only, through the queue, never changes the gateway state; IMPORT INTO CORE adds "Only in gateway" sensors to CORE only.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { exceptionPdu, readRespPdu } from "../src/drivers/modbus/frames.js"; import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { Commands } from "../src/commands.js"; import { buildApp } from "../src/app.js"; import { hashPassword, createSession } from "../src/auth.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const ADMIN = { username: "admin", role: "admin" };
const BENCH = [112600317, 112600318, 112500501, 112500502, 11242748];                                  // bench frame: slots 1-5, interval 5, control 0
const thRegs = (serials: (number | null)[] = BENCH, slotsAt: number[] = serials.map((_, i) => i)) => { const r = new Array(120).fill(0xffff); serials.forEach((s, i) => { if (s === null) return; const o = slotsAt[i] * 4; r.splice(o, 4, Math.floor(s / 65536), s & 0xffff, 5, 0); }); return r; };

interface Opts { soil?: "exception" | "silent" | "ok"; version?: "ok" | "exception" | "silent"; th?: number[]; data?: number[]; }
async function rig(o: Opts = {}, timeoutMs = 150) {
  const seen: { fc: number; addr: number; count: number }[] = []; const line = { tx: [] as number[][], slave: null as any };
  line.slave = (_u: number, pdu: Buffer) => { line.tx.push([_u, pdu[0]]);
    const fc = pdu[0], addr = pdu.readUInt16BE(1), count = pdu.readUInt16BE(3); seen.push({ fc, addr, count });
    if (fc === 4 && addr <= 2) { const v = [7, 300, 21][addr]; if (addr === 2 && o.version === "exception") return exceptionPdu(4, 2); if (addr === 2 && o.version === "silent") return null; return readRespPdu(4, [v]); }   // ONE register per read, whatever the count
    if (fc === 4 && addr === 0x0100) return readRespPdu(4, (o.th ?? thRegs()).slice(0, count));
    if (fc === 4 && addr === 0x0600) { if (o.soil === "exception") return exceptionPdu(4, 2); if (o.soil === "silent") return null; return readRespPdu(4, new Array(count).fill(0xffff)); }
    if (fc === 3 && addr === 1) return readRespPdu(3, (o.data ?? Array.from({ length: 120 }, (_, i) => [215, 600, 330, 0xffc4][i % 4])).slice(0, count));
    return exceptionPdu(fc, 2);
  };
  const srv = serveSim({ handle: (u, pdu) => line.slave(u, pdu) }, 0, "mbap"); await new Promise((r) => srv.once("listening", r)); const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); const m = new ModbusMaster(tr, { unit: 7, timeoutMs, retries: 1 });
  const db = openDb(":memory:"), reg = new Registry(db, map), svc = new GatewayService(db, reg, new Ingest(db), new GatewayDriver(m, map));
  after(async () => { await svc.stop(); await tr.close(); srv.close(); });
  return { line, seen, m, db, reg, svc };
}
const audits = (db: any, action: string) => (db.prepare("SELECT detail FROM audit_log WHERE action=? ORDER BY id").all(action) as { detail: string }[]).map((r) => JSON.parse(r.detail));

test("system registers are read one by one with count 1; a count-3 system read is never requested; the first poll reads the config with ONE 120-register request", async () => {
  const { svc, seen, line } = await rig(); await svc.pollNow();
  assert.deepEqual(seen.filter((r) => r.fc === 4 && r.addr <= 2), [{ fc: 4, addr: 0, count: 1 }, { fc: 4, addr: 1, count: 1 }, { fc: 4, addr: 2, count: 1 }]); assert.ok(!seen.some((r) => r.count === 3));
  assert.deepEqual(svc.info, { address: 7, groupAddress: 300, version: 21 }); assert.equal(svc.online, true, "ONLINE"); assert.equal(svc.lastError, null);
  assert.ok(seen.some((r) => r.fc === 4 && r.addr === 0x0100 && r.count === 120)); assert.equal(line.tx.length, seen.length);
});

test("version register: an exception, a timeout or an out-of-range answer is a warning, never OFFLINE; address and PID still fill the info card", async () => {
  for (const version of ["exception", "silent"] as const) {
    const { svc } = await rig({ version }); const err: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => { err.push(a.join(" ")); }; try { await svc.pollNow(); } finally { console.warn = w; }
    assert.equal(svc.online, true, `version ${version}: gateway stays ONLINE`); assert.equal(svc.failCycles, 0); assert.equal(svc.info.address, 7); assert.equal(svc.info.groupAddress, 300); assert.equal(svc.info.version, undefined);
    assert.ok(err.some((l) => /gateway system register: version register/.test(l)), "a warning was logged");
  }
});

test("T/H section: the bench frame (5 configured + 25 empty), all 'In CORE'; header numbers, raw hex, byte count and audit entry", async () => {
  const { svc, reg, db, seen } = await rig(); reg.add(ADMIN, "th", BENCH.map(String)); const r = await svc.readSection(ADMIN, "th");
  assert.equal(r.ok, true); assert.equal(r.used, 5); assert.equal(r.total, 30); assert.equal(r.slots.length, 30); assert.deepEqual(r.slots.slice(0, 5).map((s) => [s.slot, s.serial, s.interval, s.control, s.state, s.match]), BENCH.map((s, i) => [i + 1, String(s), 5, 0, "CONFIGURED", "in_core"]));
  assert.ok(r.slots.slice(5).every((s) => s.state === "EMPTY" && s.serial === null)); assert.deepEqual(r.onlyInCore, []); assert.equal(r.bytes, 240); assert.match(r.hex, /^06 b6 24 fd 00 05 00 00 06 b6 24 fe 00 05 00 00/); assert.ok(r.tookMs >= 0);
  assert.deepEqual(seen.filter((x) => x.addr === 0x0100), [{ fc: 4, addr: 0x0100, count: 120 }]); assert.deepEqual(audits(db, "gateway.read_section"), [{ section: "th", slots_used: 5, result: "ok", only_in_gateway: 0, only_in_core: 0, slot_mismatch: 0 }]);
  assert.equal(r.importable, true); assert.equal(svc.online, false, "a section read does not touch the gateway state (never polled here)");
});

test("T/H section with CORE empty: every configured slot is 'Only in gateway'; IMPORT adds them with slot + interval, writes nothing to the gateway, is audited and runs twice without duplicates", async () => {
  const { svc, db, line } = await rig(); const r = await svc.readSection(ADMIN, "th"); assert.ok(r.slots.filter((s) => s.state === "CONFIGURED").every((s) => s.match === "only_gateway"));
  const writes = () => line.tx.filter((f) => f[1] === 6 || f[1] === 16).length; const imp = await svc.importSection(ADMIN, "th"); assert.deepEqual(imp.added, BENCH.map(String)); assert.equal(writes(), 0, "never writes to the gateway");
  const rows = db.prepare("SELECT serial,slot,reporting_interval,sent_slot FROM sensors ORDER BY slot").all() as any[]; assert.deepEqual(rows.map((x) => [x.serial, x.slot, x.reporting_interval, x.sent_slot]), BENCH.map((s, i) => [String(s), i + 1, 5, i + 1]));
  assert.deepEqual(audits(db, "gateway.import_section"), [{ section: "th", added: 5, skipped: 0 }]); assert.deepEqual((await svc.importSection(ADMIN, "th")).added, []);
});

test("T/H section: the same serial in another slot is flagged slot_mismatch; CORE sensors the gateway does not hold are listed as 'Only in CORE'", async () => {
  const { svc, reg, db } = await rig(); reg.add(ADMIN, "th", ["112600317", "112600318", "99999999"]); db.prepare("UPDATE sensors SET slot=9 WHERE serial='112600318'").run();
  const r = await svc.readSection(ADMIN, "th"); assert.equal(r.slots[0].match, "in_core"); assert.equal(r.slots[1].match, "slot_mismatch"); assert.equal(r.slots[1].coreSlot, 9); assert.equal(r.slots[2].match, "only_gateway");
  assert.deepEqual(r.onlyInCore.map((x) => x.serial), ["99999999"]); assert.deepEqual(audits(db, "gateway.read_section")[0], { section: "th", slots_used: 5, result: "ok", only_in_gateway: 3, only_in_core: 1, slot_mismatch: 1 });
});

test("odd data never crashes: serial 0 and 0xFFFFFFFF are EMPTY, an all-zero group is EMPTY", async () => {
  const regs = thRegs([112600317, 0, 0xffffffff, null]); regs.splice(4, 4, 0, 0, 5, 3); regs.splice(8, 4, 0xffff, 0xffff, 5, 3); regs.splice(12, 4, 0, 0, 0, 0);
  const { svc } = await rig({ th: regs }); const r = await svc.readSection(ADMIN, "th"); assert.equal(r.used, 1); assert.deepEqual(r.slots.slice(0, 4).map((s) => s.state), ["CONFIGURED", "EMPTY", "EMPTY", "EMPTY"]);
});

test("soil section: an exception reply and a timeout both give the clear message, change NO gateway state (no OFFLINE, no failed cycle), and are audited without sensitive data", async () => {
  for (const soil of ["exception", "silent"] as const) {
    const { svc, db } = await rig({ soil }); await svc.pollNow(); assert.equal(svc.online, true); const before = { online: svc.online, fails: svc.failCycles, err: svc.lastError, ok: svc.lastOk };
    const r = await svc.readSection(ADMIN, "soil"); assert.equal(r.ok, false); assert.match(r.error!, /^Gateway did not answer the Soil section: /);
    assert.match(r.error!, soil === "exception" ? /exception 2 \(illegal data address\) to FC04 addr 0x0600 count 40/ : /timeout/i);
    assert.deepEqual({ online: svc.online, fails: svc.failCycles, err: svc.lastError, ok: svc.lastOk }, before, "gateway state unchanged"); await svc.pollNow(); assert.equal(svc.online, true);
    assert.equal(audits(db, "gateway.read_section")[0].result, "failed"); assert.equal(audits(db, "gateway.read_section")[0].section, "soil");
  }
});

test("soil section that answers: table is read-only here (soil type is not enabled), the note says so, and IMPORT is refused", async () => {
  const { svc } = await rig(); const r = await svc.readSection(ADMIN, "soil"); assert.equal(r.ok, true); assert.equal(r.total, 10); assert.equal(r.slots.length, 10); assert.equal(r.count, 40); assert.equal(r.importable, false); assert.equal(r.importNote, "Soil import comes with Milestone 2b");
  await assert.rejects(() => svc.importSection(ADMIN, "soil"), /Milestone 2b/);
});

test("HTTP: Admin gets the section read and the import; an Operator gets 403 and nothing is read", async () => {
  const { svc, db, reg, seen } = await rig(); const commands = new Commands(db, { publish() {} } as any, () => {});
  const { app } = await (buildApp as any)(db, new Ingest(db), commands, reg, svc, null, null); await app.listen({ port: 0, host: "127.0.0.1" }); after(() => void app.close());
  const mk = (n: string, role: string) => "core_session=" + createSession(db, Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(n, hashPassword("x".repeat(10)), role, 1).lastInsertRowid));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, post = (p: string, cookie: string) => fetch(url + p, { method: "POST", headers: { cookie } });
  const op = await post("/api/gateway/read-section/th", mk("op", "operator")); assert.equal(op.status, 403); assert.equal(seen.filter((x) => x.addr === 0x0100).length, 0);
  const ad = mk("adm", "admin"); const r = await (await post("/api/gateway/read-section/th", ad)).json() as any; assert.equal(r.used, 5); assert.equal((await post("/api/gateway/import-section/th", mk("op2", "operator"))).status, 403);
  const imp = await (await post("/api/gateway/import-section/th", ad)).json() as any; assert.equal(imp.added.length, 5);
  assert.equal((await post("/api/gateway/read-section/nope", ad)).status, 400);
});
