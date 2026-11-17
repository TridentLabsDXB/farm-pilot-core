import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// Operator data check, server side. Boots the REAL app (buildApp) with seeded sensors, calibrations, alarms and a gateway simulator, logs in as an Operator and:
//  1. calls EVERY registered route: only the routes an Operator needs may answer; every other route must refuse (403/401);
//  2. scans every Operator response (and every WebSocket message) and FAILS if a serial, a raw value, calibration data, a setting or an audit/setup field appears;
//  3. checks the same routes work for an Admin, so the scan is not passing on empty bodies.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import type { AddressInfo } from "node:net"; import WebSocket from "ws";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" }; const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const SERIALS = ["112600310", "112600311", "112600312"];

// Routes an Operator legitimately uses. Everything else must refuse.
const OPERATOR_OK = new Set(["GET /api/me", "GET /api/mqtt", "GET /api/about", "GET /api/state", "GET /api/control", "GET /api/history", "GET /api/history/export.csv", "GET /api/reports/meta", "GET /api/scada", "GET /api/alarms", "GET /api/alarms/history", "GET /api/gateway/status", "GET /api/farm-profile/public", "GET /api/branding", "GET /api/farm-profile/logo", "GET /api/farm-contacts/alarm-view", "POST /api/commands", "POST /api/alarms/:id/ack", "POST /api/logout"]);
const PUBLIC = new Set(["POST /api/login", "GET /api/health"]);
// Keys that may never appear in an Operator response, at any depth.
const FORBIDDEN_KEYS = new Set(["serial", "slot", "raw", "temperature_raw", "humidity_raw", "offset", "gain", "calibratedBy", "calibratedAt", "calDueAt", "calibrated", "calibrated_by", "intervalSec", "offlineAfterSec", "lowVoltage", "intervalOk", "applying",
  "syncState", "sentInterval", "labelSet", "thresholds", "settings", "rssiGood", "rssiPoor", "mapVersion", "types", "unassigned", "pending", "detail", "audit", "password", "pass_hash", "token_hash"]);

async function boot() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port });
  const ingest = new Ingest(db); const reg = new Registry(db, map); const gw = new GatewayService(db, reg, ingest, new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  const commands = new Commands(db, { publish() {} } as any, () => {}); const { app, routes } = await buildApp(db, ingest, commands, reg, gw);
  await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => { void app.close(); void tr.close(); srv.close(); });
  const port = (app.server.address() as AddressInfo).port;
  // users + sessions
  const mk = (name: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(name, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return { id, cookie: "core_session=" + createSession(db, id) }; };
  const admin = mk("admin", "admin"), op = mk("op1", "operator");
  // data: 3 sensors (one without a label), zone, calibration (raw != calibrated), low battery on one, one calibration overdue, readings flowing
  await gw.pollNow(); reg.add(A, "th", SERIALS, [], { [SERIALS[0]]: "GH1 row 1", [SERIALS[1]]: "GH1 row 2" }); await gw.sync(A, ["th"], true);
  const z = reg.addZone(A, "Greenhouse 1", "climate"); for (const s of SERIALS) reg.assignZone(A, s, z);
  let t = Date.now(); for (let i = 0; i < 2; i++) { t += 60_000; sim.tick(t); await gw.pollNow(t); }
  reg.calibrate(A, SERIALS[0], { metric: "temperature", method: "manual", offset: 3.7, gain: 1.013 }); reg.calibrate(A, SERIALS[0], { metric: "humidity", method: "manual", offset: -4.3, gain: 1.021, dueAt: 1000 });
  t += 60_000; sim.tick(t); await gw.pollNow(t); sim.setVoltage(SERIALS[1], 3.0); t += 3_000_000; sim.tick(t); await gw.pollNow(t); sim.freeze(SERIALS[2]);
  const call = async (who: { cookie: string } | null, method: string, url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(who ? { cookie: who.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let json: any = null; try { json = JSON.parse(txt); } catch { /* not json */ } return { status: r.status, txt, json }; };
  return { db, sim, reg, gw, app, routes, port, admin, op, call, t: () => t };
}
function leaks(txt: string, json: any, ctx: { serials: string[]; rawOnly: number[] }): string[] {
  const out: string[] = []; const low = txt.toLowerCase();
  for (const s of ctx.serials) if (low.includes(s.toLowerCase())) out.push(`serial ${s} appears`);
  if (/_raw/.test(txt)) out.push("a *_raw field appears"); if (/gateway\//.test(txt)) out.push("a gateway/<type> topic appears");
  const walk = (v: any, path: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + "[" + i + "]")); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.has(k) && !(k === "offset" && path.includes(".mapping.rules"))) out.push(`forbidden key "${k}" at ${path}.${k}`); if (k === "source" && x !== "") out.push(`source is not blank at ${path}`); walk(x, path + "." + k); } else if (typeof v === "number" && ctx.rawOnly.some((r) => Math.abs(r - v) < 1e-9)) out.push(`raw value ${v} at ${path}`); };
  if (json !== null) walk(json, "$"); return out;
}
const sub = (url: string, ctx: { serial: string }) => url.replace(":serial", ctx.serial).replace(/:id/g, "1").replace(":type", "th");

test("Operator: every route either refuses (403) or returns nothing about serials, raw values, calibration, settings or audit", async () => {
  const x = await boot(); const adminSensors = (await x.call(x.admin, "GET", "/api/sensors")).json.sensors as any[]; assert.equal(adminSensors.length, 3);
  const serials = [...SERIALS, ...adminSensors.map((s) => s.serial)];
  const cal = new Set<number>(); const rawVals = new Set<number>(); for (const s of adminSensors) for (const k of ["temperature", "humidity"]) { if (typeof s[k] === "number") cal.add(s[k]); if (typeof s.raw?.[k] === "number") rawVals.add(s.raw[k]); }
  const rawOnly = [...rawVals].filter((r) => !cal.has(r)); assert.ok(rawOnly.length >= 2, "test data must contain raw values that differ from the calibrated ones");
  assert.ok(adminSensors.some((s) => s.calibrated) && adminSensors.some((s) => s.status === "low_battery") && adminSensors.some((s) => s.calDue), "seed data must include calibration, low battery and calibration due");
  const rows: string[] = []; const ctx = { serial: SERIALS[0] }; let guarded = 0, allowed = 0;
  const list = x.routes.filter((r) => r.url.startsWith("/api/") && r.method !== "HEAD" && r.method !== "OPTIONS" && !r.url.includes("*"));
  assert.ok(list.length >= 40, `expected to find the whole API, found ${list.length} routes`);
  x.db.prepare("UPDATE alarm_events SET id=id").run(); await x.call(x.admin, "GET", "/api/alarms/history");           // opens alarm rows (no_update on the frozen sensor, low battery, calibration due)
  for (const r of list) {
    const key = `${r.method} ${r.url}`; if (PUBLIC.has(key) || r.url === "/api/logout") continue;
    const body = r.method === "GET" || r.method === "DELETE" ? undefined : key === "POST /api/commands" ? { pump: "pump1", action: "off" } : {};
    const res = await x.call(x.op, r.method, sub(r.url, ctx), body);
    if (OPERATOR_OK.has(key)) {
      allowed++; assert.ok([200, 400, 404].includes(res.status), `${key}: operator got ${res.status}`); const l = leaks(res.txt, res.json, { serials, rawOnly }); assert.deepEqual(l, [], `${key} leaks to an Operator: ${l.join("; ")}`);
      const adm = await x.call(x.admin, r.method, sub(r.url, ctx), body); assert.ok(adm.status < 500, `${key} admin ${adm.status}`); rows.push(`${key.padEnd(40)} operator ${res.status}  (allowed, scanned ${res.txt.length} bytes)`);
    } else { guarded++; assert.equal(res.status, 403, `${key}: an Operator must get 403, got ${res.status} ${res.txt.slice(0, 80)}`); const l = leaks(res.txt, res.json, { serials, rawOnly }); assert.deepEqual(l, [], `${key} refusal leaks: ${l.join("; ")}`); rows.push(`${key.padEnd(40)} operator 403`); }
  }
  console.log(`\nOPERATOR ROUTE CHECK: ${list.length} routes, ${guarded} refused with 403, ${allowed} allowed and scanned (${[...OPERATOR_OK].length} expected)\n` + rows.join("\n"));
  assert.equal(allowed, OPERATOR_OK.size - 1, "every allowed Operator route must exist (logout excluded)");
  // the scan itself must be able to fail: the ADMIN view of the same data is full of forbidden things
  const adminScada = await x.call(x.admin, "GET", "/api/scada"); assert.ok(leaks(adminScada.txt, adminScada.json, { serials, rawOnly }).length > 3, "the scan must detect leaks in the admin response");
  // spot checks of what an Operator DOES get
  const opScada = (await x.call(x.op, "GET", "/api/scada")).json; const names = opScada.zones[0].sensors.map((s: any) => s.label); assert.deepEqual(names, ["GH1 row 1", "GH1 row 2", "Sensor 3"]);   // unlabeled sensor: never the serial
  assert.equal(typeof opScada.zones[0].sensors[0].temperature, "number"); assert.equal(opScada.settings, undefined);
  const st = (await x.call(x.op, "GET", "/api/state")).json; assert.ok(st.topics.every((t: any) => t.topic.startsWith("farmpilot/")), "/api/state must not list gateway topics");
});

test("Operator: WebSocket stream carries no serials, raw values or setup data; anonymous sockets are refused", async () => {
  const x = await boot(); const sensors = (await x.call(x.admin, "GET", "/api/sensors")).json.sensors as any[];
  const serials = sensors.map((s) => s.serial); const rawOnly = sensors.flatMap((s) => [s.raw.temperature, s.raw.humidity]).filter((v: any) => typeof v === "number");
  const anon = new WebSocket(`ws://127.0.0.1:${x.port}/ws`); const code = await new Promise<number>((res) => { anon.on("close", (c) => res(c)); anon.on("error", () => {}); }); assert.equal(code, 4401);
  const msgs: string[] = []; const ws = new WebSocket(`ws://127.0.0.1:${x.port}/ws`, { headers: { cookie: x.op.cookie } }); await new Promise((r) => ws.once("open", r)); ws.on("message", (m) => msgs.push(String(m)));
  let t = x.t(); for (let i = 0; i < 3; i++) { t += 60_000; x.sim.tick(t); await x.gw.pollNow(t); }                        // each poll pushes a "scada" event
  await x.call(x.op, "POST", "/api/commands", { pump: "pump1", action: "on" });                                          // pushes a "command" event
  await new Promise((r) => setTimeout(r, 700)); ws.close();
  assert.ok(msgs.length >= 2, `expected pushed messages, got ${msgs.length}`); for (const m of msgs) { const l = leaks(m, JSON.parse(m), { serials, rawOnly }); assert.deepEqual(l, [], `WebSocket message leaks: ${m.slice(0, 120)} -> ${l.join("; ")}`); }
  console.log(`\nOPERATOR WEBSOCKET CHECK: ${msgs.length} messages (${[...new Set(msgs.map((m) => JSON.parse(m).type))].join(", ")}), no leaks; anonymous socket closed with 4401`);
});

test("Delete user: deleting a user ends their sessions and keeps the actor safe; you cannot delete or disable yourself", async () => {
  const x = await boot(); const { createSession: cs } = await import("../src/auth.js"); const mkAdmin = (n: string) => { const id = Number(x.db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,'admin',1)").run(n, hashPassword("y".repeat(10))).lastInsertRowid); return { id, cookie: "core_session=" + cs(x.db, id) }; };
  const b = mkAdmin("admin2");
  assert.equal((await x.call(x.admin, "DELETE", `/api/users/${x.admin.id}`)).status, 400);                                  // yourself
  assert.equal((await x.call(x.admin, "POST", `/api/users/${x.admin.id}`, { active: false })).status, 400);
  assert.equal((await x.call(b, "GET", "/api/me")).status, 200);
  assert.equal((await x.call(x.admin, "DELETE", `/api/users/${b.id}`)).status, 200);                                        // another Admin: allowed, the caller stays
  assert.equal((await x.call(b, "GET", "/api/me")).status, 401, "a deleted user's session must be dead"); assert.equal((x.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id=?").get(b.id) as any).c, 0);
  assert.equal((await x.call(x.admin, "DELETE", "/api/users/9999")).status, 404); assert.equal((await x.call(x.op, "DELETE", `/api/users/${x.admin.id}`)).status, 403);
  assert.equal((x.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='user.delete'").get() as any).c, 1);
});
