// RS-485 Ports: validation, migration of the old gateway link into Port 1, per-port queue isolation, and the manager end to end on TWO simulator TCP targets
// (gateway sim = Port 1, WN90LP sim = Port 2): move a device between ports, TEST PORT per device, stop one simulator, wrong settings + REVERT, audit, backup round trip.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import type { AddressInfo, Server } from "node:net"; import { createServer } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js"; import { Wn90lpSim } from "../src/tools/wn90lp-sim/sim.js";
import { ModbusMaster, PortQueue } from "../src/drivers/modbus/master.js"; import { createTransport } from "../src/drivers/modbus/transport.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";
import { PortStore } from "../src/ports/store.js"; import { PortManager } from "../src/ports/manager.js";
import { mergePort, validateAssignment, validateDevice, validatePort, validatePorts, type PortRow } from "../src/ports/validate.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" }; const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const base: PortRow = { id: 1, label: "Port 1", enabled: true, transport: "serial", device_path: "/dev/ttyUSB0", tcp_host: "", tcp_port: 502, tcp_framing: "rtu", baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, timeout_ms: 1000, retries: 2, turnaround_ms: 50 };
const env = { transport: "tcp" as const, host: "127.0.0.1", port: 5020, serialPath: "/dev/ttyUSB0", baud: 9600, parity: "none" as const, address: 0, timeoutMs: 1500, retries: 2 };
const listen = (s: Server) => new Promise<number>((r) => s.once("listening", () => r((s.address() as AddressInfo).port)));

test("port validation: baud, parity, stop bits, device path, TCP target", () => {
  assert.deepEqual(validatePort(base), []);
  assert.match(validatePort({ ...base, baud: 12345 }).join(), /baud/); assert.match(validatePort({ ...base, parity: "mark" as any }).join(), /parity/); assert.match(validatePort({ ...base, stop_bits: 3 }).join(), /stop bits/);
  assert.match(validatePort({ ...base, device_path: "" }).join(), /choose a serial device/); assert.match(validatePort({ ...base, device_path: "/etc/passwd" }).join(), /under \/dev/); assert.match(validatePort({ ...base, device_path: "/dev/../etc/passwd" }).join(), /under \/dev/);
  assert.match(validatePort({ ...base, transport: "tcp", tcp_host: "bad host!", tcp_port: 0 }).join(), /host/); assert.deepEqual(validatePort({ ...base, enabled: false, device_path: "" }), []);   // a switched-off port needs no device
});
test("the same serial device (or TCP target) on two ports is refused", () => {
  assert.match(validatePorts([base, { ...base, id: 2 }]).join(), /same serial device/); assert.deepEqual(validatePorts([base, { ...base, id: 2, device_path: "/dev/ttyUSB1" }]), []);
  assert.match(validatePorts([{ ...base, transport: "tcp", tcp_host: "10.0.0.5", tcp_port: 502 }, { ...base, id: 2, transport: "tcp", tcp_host: "10.0.0.5", tcp_port: 502 }]).join(), /same TCP target/);
});
test("device address rules: forbidden gateway addresses, clash on one port, allowed on different ports", () => {
  const gw = { id: 1, kind: "lora_gateway" as const, model: "XZ-DS-MUS2", port_id: 1, modbus_address: 7, poll_interval_s: 30, enabled: true }, wx = { id: 2, kind: "weather" as const, model: "WN90LP", port_id: 1, modbus_address: 7, poll_interval_s: 30, enabled: true };
  for (const a of [0, 123, 160, 255]) assert.match(validateDevice({ ...gw, modbus_address: a }, [base]).join(), /never|1 to/);
  assert.deepEqual(validateDevice(gw, [base]), []); assert.match(validateAssignment([gw, wx]).join(), /must differ/); assert.deepEqual(validateAssignment([gw, { ...wx, port_id: 2 }]), []); assert.deepEqual(validateAssignment([gw, { ...wx, enabled: false }]), []);
  assert.equal(mergePort(base, { baud: "19200" }).baud, 19200);
});
test("first start migrates the environment gateway link into Port 1 + device row, once", () => {
  const db = openDb(":memory:"), st = new PortStore(db);
  assert.equal(st.migrateFromEnv(env, 7), true); assert.equal(st.migrateFromEnv({ ...env, port: 9999 }, 7), false);
  const [p1, p2] = st.ports(); assert.equal(p1.tcp_port, 5020); assert.equal(p1.tcp_framing, "mbap"); assert.equal(p1.enabled, true); assert.equal(p2.enabled, false);
  const [gw, wx] = st.devices(); assert.deepEqual([gw.kind, gw.port_id, gw.modbus_address], ["lora_gateway", 1, 7]); assert.deepEqual([wx.kind, wx.port_id, wx.modbus_address], ["weather", 2, 144]);
  const db2 = openDb(":memory:"), st2 = new PortStore(db2); st2.migrateFromEnv({ ...env, transport: "rtu-serial", serialPath: "/dev/serial/by-id/usb-x", baud: 19200, address: 9 }, 7);
  assert.deepEqual([st2.port(1)!.transport, st2.port(1)!.device_path, st2.port(1)!.baud, st2.devices()[0].modbus_address], ["serial", "/dev/serial/by-id/usb-x", 19200, 9]);
  const db3 = openDb(":memory:"), st3 = new PortStore(db3); st3.migrateFromEnv({ ...env, transport: "off" }, 7); assert.equal(st3.port(1)!.enabled, false);
});
test("per-port queue isolation: a hung device on Port 2 does not delay Port 1", async () => {
  const hang = createServer((s) => s.on("data", () => {})); hang.listen(0, "127.0.0.1"); const hp = await listen(hang);
  const sim = new GatewaySim(map), ok = serveSim(sim, 0, "mbap"); const op = await listen(ok); closers.push(() => { hang.close(); ok.close(); });
  const q2 = new PortQueue(createTransport({ type: "tcp", host: "127.0.0.1", port: hp }), { timeoutMs: 600, retries: 0, turnaroundMs: 0 }); const q1 = new PortQueue(createTransport({ type: "tcp", host: "127.0.0.1", port: op }), { timeoutMs: 600, retries: 0, turnaroundMs: 0 });
  const m2 = new ModbusMaster(q2, { unit: 144, timeoutMs: 600, retries: 0 }), m1 = new ModbusMaster(q1, { unit: map.default_gateway_address, timeoutMs: 600, retries: 0 });
  const stuck = m2.read(3, 0, 1).catch((e) => e); const t0 = Date.now(); await m1.read(map.system.read_fc as 4, map.system.address, 1); assert.ok(Date.now() - t0 < 300, "Port 1 answered while Port 2 was hung");
  assert.match(String(await stuck), /timeout/);
});
test("one queue per port: writes jump ahead of polls, one request at a time", async () => {
  const sim = new GatewaySim(map), srv = serveSim(sim, 0, "mbap"); const p = await listen(srv); closers.push(() => srv.close());
  const q = new PortQueue(createTransport({ type: "tcp", host: "127.0.0.1", port: p }), { timeoutMs: 400, retries: 0, turnaroundMs: 0 }); const m = new ModbusMaster(q, { unit: map.default_gateway_address, timeoutMs: 400, retries: 0 });
  const order: string[] = []; const a = m.read(map.system.read_fc as 4, map.system.address, 1, "poll").then(() => order.push("poll1")), b = m.read(map.system.read_fc as 4, map.system.address, 1, "poll").then(() => order.push("poll2")), c = m.read(map.system.read_fc as 4, map.system.address, 1, "write").then(() => order.push("write"));
  await Promise.all([a, b, c]); assert.deepEqual(order, ["poll1", "write", "poll2"]);            // poll1 was already on the wire; the write overtakes poll2
});

async function rig() {
  const db = openDb(":memory:"); const gsim = new GatewaySim(map), wsim = new Wn90lpSim(144); const gs = serveSim(gsim, 0, "mbap"), ws = serveSim(wsim, 0, "mbap"); const [gp, wp] = await Promise.all([listen(gs), listen(ws)]);
  const store = new PortStore(db); store.migrateFromEnv({ ...env, port: gp, timeoutMs: 150, retries: 0 }, map.default_gateway_address);
  const reg = new Registry(db, map); const gw = new GatewayService(db, reg, new Ingest(db), null); gw.start(); const mgr = new PortManager(db, store, map, gw); await mgr.start();
  closers.push(() => { void mgr.stop(); void gw.stop(); gs.close(); ws.close(); });
  // Port 2 = weather simulator (Modbus TCP framing on the bench)
  const r = await mgr.applyPort(A, 2, { enabled: true, transport: "tcp", tcp_host: "127.0.0.1", tcp_port: wp, tcp_framing: "mbap", timeout_ms: 150, retries: 0, turnaround_ms: 0 }); assert.equal(r.pending, null);
  await gw.pollNow(); return { db, store, mgr, gw, gsim, wsim, gp, wp };
}
const audits = (db: any, like: string) => db.prepare("SELECT action,detail FROM audit_log WHERE action LIKE ?").all(like) as { action: string; detail: string }[];

test("two ports end to end: TEST PORT reports per device, lamps follow, audit written", async () => {
  const { db, mgr, gw } = await rig(); assert.equal(gw.online, true);
  const t1 = await mgr.test(1), t2 = await mgr.test(2); assert.deepEqual(t1.results.map((r) => [r.model, r.result]), [["XZ-DS-MUS2", "ok"]]); assert.deepEqual(t2.results.map((r) => [r.model, r.result]), [["WN90LP", "ok"]]); assert.ok(t2.results[0].ms! >= 0);
  const v = mgr.view(); assert.deepEqual(v.ports.map((p) => p.status), ["OPEN", "OPEN"]); assert.equal(v.ports[0].devices, 1); assert.equal(mgr.deviceState(v.devices[0] as any), "online");
  const a = audits(db, "ports.update"); assert.equal(a.length, 1); assert.deepEqual(JSON.parse(a[0].detail).port, 2);
});
test("stop the weather simulator: the gateway stays ONLINE, weather goes NO ANSWER", async () => {
  const { mgr, gw, wsim } = await rig(); wsim.silent = true; const t2 = await mgr.test(2); assert.equal(t2.results[0].result, "no_answer"); await gw.pollNow(); assert.equal(gw.online, true); assert.equal((await mgr.test(1)).results[0].result, "ok");
});
test("move the gateway from Port 1 to Port 2 and back without a restart", async () => {
  const { mgr, gw, gsim, store, gp } = await rig(); const dev = store.devices()[0];
  // Port 2 currently reaches the WN90LP simulator, so moving the gateway there must fail its TEST and wait for KEEP or REVERT.
  const r = await mgr.applyDevice(A, dev.id, { port_id: 2, modbus_address: 7 }); assert.ok(r.pending, "gateway was online before and not answering afterwards: waiting for KEEP or REVERT");
  await mgr.revert(A, undefined, "test"); assert.equal(store.device(dev.id)!.port_id, 1); await gw.pollNow(); assert.equal(gw.online, true);
  // Bench "switch around": a second TCP front door of the SAME gateway simulator becomes Port 2's target (the same target on two ports is refused, see above).
  await assert.rejects(mgr.applyPort(A, 2, { tcp_port: gp }), /same TCP target/);
  const gs2 = serveSim(gsim, 0, "mbap"); const p2 = await listen(gs2); closers.push(() => gs2.close());
  const sw = await mgr.applyPort(A, 2, { tcp_port: p2 }); if (sw.pending) mgr.keep(A);        // pending only if the liveness poll had already marked the weather station online
  const mv = await mgr.applyDevice(A, dev.id, { port_id: 2 }); assert.equal(mv.pending, null); assert.equal(store.device(dev.id)!.port_id, 2); await gw.pollNow(); assert.equal(gw.online, true); assert.equal(gsim.address, map.default_gateway_address);
  assert.equal(mgr.view().devices.find((d) => d.kind === "weather")!.state === "online", false);        // the weather simulator is on no port now
  const back = await mgr.applyDevice(A, dev.id, { port_id: 1 }); assert.equal(back.pending, null); await gw.pollNow(); assert.equal(gw.online, true); assert.equal(gw.paused, false);
});
test("address clash on one port and shared-bus warning", async () => {
  const { mgr, store } = await rig(); const wx = store.devices().find((d) => d.kind === "weather")!, gw = store.devices()[0];
  await assert.rejects(mgr.applyDevice(A, wx.id, { port_id: 1, modbus_address: gw.modbus_address }), /must differ/);
  const ok = await mgr.applyDevice(A, wx.id, { port_id: 1, modbus_address: 144 }); assert.ok(ok.ok); assert.deepEqual(mgr.view().shared, [1]);
});
test("wrong settings: NO ANSWER, change waits for confirmation, REVERT restores, auto-revert after the window", async () => {
  const { db, mgr, gw, store, gp } = await rig();
  const r = await mgr.applyPort(A, 1, { tcp_port: gp + 1 }); assert.ok(r.pending); assert.ok(r.results.every((x) => x.result !== "ok")); assert.equal(mgr.view().pending !== null, true);
  await assert.rejects(mgr.applyPort(A, 1, { baud: 19200 }), /waiting to be kept or reverted/);
  await mgr.revert(A, 1); assert.equal(store.port(1)!.tcp_port, gp); assert.equal(mgr.view().pending, null); await gw.pollNow(); assert.equal(gw.online, true);
  assert.equal(audits(db, "ports.revert").length, 1);
  const r2 = await mgr.applyPort(A, 1, { baud: 19200 }); assert.equal(r2.pending, null); assert.equal(store.port(1)!.baud, 19200);       // TCP ignores baud: the device still answers, so nothing to confirm
  const r3 = await mgr.applyPort(A, 1, { tcp_port: gp + 1 }); assert.ok(r3.pending); mgr.keep(A); assert.equal(mgr.view().pending, null); assert.equal(store.port(1)!.tcp_port, gp + 1);   // KEEP accepts it: it is now the stored state
  assert.equal(audits(db, "ports.keep").length, 1);
});
test("auto-revert: no confirmation inside the window restores the old settings", async () => {
  const { mgr, store, gw, gp } = await rig(); const real = setTimeout; (globalThis as any).setTimeout = (f: any, ms: number, ...a: any[]) => real(f, ms === 30_000 ? 150 : ms, ...a);
  try { const r = await mgr.applyPort(A, 1, { tcp_port: gp + 1 }); assert.ok(r.pending); await new Promise((res) => real(res, 700)); } finally { (globalThis as any).setTimeout = real; }
  assert.equal(store.port(1)!.tcp_port, gp); assert.equal(mgr.view().pending, null); await gw.pollNow(); assert.equal(gw.online, true);
});
test("backup round trip keeps ports and assignments; a missing serial device shows NOT FOUND", async () => {
  const { mgr, store, db } = await rig(); const b = JSON.parse(JSON.stringify(mgr.exportParts())); b.ports[1] = { ...b.ports[1], enabled: true, transport: "serial", device_path: "/dev/serial/by-id/usb-NOPE-if00" };
  mgr.checkBackup(b); await mgr.restoreParts(A, b); assert.equal(store.port(2)!.device_path, "/dev/serial/by-id/usb-NOPE-if00"); assert.equal(mgr.view().ports[1].status, "NOT FOUND"); assert.equal(store.devices().length, 2);
  assert.throws(() => mgr.checkBackup({ ports: [{ ...b.ports[0], baud: 1 }], devices: [] }), /baud/); assert.equal(audits(db, "ports.restore").length, 1);
});

// ---- API: Admin only, 403 for Operators, audit entries ----
import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
test("API: Operator gets 403 on every ports/devices route, Admin works, change is audited, stable by-id list endpoint answers", async () => {
  const { db, mgr, gw, store } = await rig(); const reg = new Registry(db, map);
  const { app, routes } = await buildApp(db, new Ingest(db), new Commands(db, { publish() {} } as any, () => {}), reg, gw, null, mgr); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => void app.close());
  const port = (app.server.address() as AddressInfo).port;
  const mk = (n: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(n, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return "core_session=" + createSession(db, id); };
  const admin = mk("adm", "admin"), op = mk("op", "operator");
  const call = async (c: string, m: string, u: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { cookie: c, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  const mine = routes.filter((r) => /^\/api\/(ports|devices)/.test(r.url) && r.method !== "HEAD"); assert.ok(mine.length >= 8, "all ports routes registered");
  for (const r of mine) assert.equal((await call(op, r.method, r.url.replace(":id", "1"), r.method === "PUT" || r.method === "POST" ? {} : undefined)).status, 403, `${r.method} ${r.url} must refuse an Operator`);
  const list = await call(admin, "GET", "/api/ports"); assert.equal(list.status, 200); assert.equal(list.json.ports.length, 2); assert.equal(list.json.devices.length, 2); assert.deepEqual(list.json.defaults, { baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, timeout_ms: 1000, retries: 2, turnaround_ms: 50 });
  assert.equal((await call(admin, "GET", "/api/ports/available")).status, 200);
  const bad = await call(admin, "PUT", "/api/ports/1", { baud: 7 }); assert.equal(bad.status, 400); assert.match(bad.json.error, /baud/);
  const put = await call(admin, "PUT", "/api/ports/2", { label: "Port 2 - WN90LP" }); assert.equal(put.status, 200); assert.equal(store.port(2)!.label, "Port 2 - WN90LP");
  const t = await call(admin, "POST", "/api/ports/1/test"); assert.equal(t.json.results[0].result, "ok");
  const row = db.prepare("SELECT username,detail FROM audit_log WHERE action='ports.update' ORDER BY id DESC").get() as any; assert.equal(row.username, "adm"); assert.equal(JSON.parse(row.detail).new.label, "Port 2 - WN90LP");
  const gwv = await call(admin, "GET", "/api/gateway"); assert.equal(gwv.json.link.line, "9600 8N1"); assert.equal(gwv.json.link.portId, 1);
  const bk = await call(admin, "GET", "/api/backup"); assert.equal(bk.json.ports.length, 2); assert.equal(bk.json.devices.length, 2);
});
