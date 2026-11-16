// Licence limits through the REAL app with a gateway simulator: the 11th sensor over HTTP, "add unassigned", restore, SEND TO GATEWAY -- and, over the limit, polling, alarms and pump commands keep working.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { LicenceService } from "../src/licence/service.js"; import { usage } from "../src/licence/usage.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" }; const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const LIMIT_MSG = "Free licence allows 10 sensors in total. Upload a licence on the About page.";
const ser = (n: number) => String(112600000 + n);
async function boot() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port });
  const ingest = new Ingest(db); const reg = new Registry(db, map); const gw = new GatewayService(db, reg, ingest, new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  const lic = new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-lim-")), deviceId: () => "FP-AAAA-BBBB-CCCC" });
  const { app } = await buildApp(db, ingest, new Commands(db, { publish() {} } as any, () => {}), reg, gw, null, null, lic); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => { void app.close(); void tr.close(); srv.close(); });
  const port = (app.server.address() as AddressInfo).port; const mk = (n: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,1)").run(n, hashPassword("x".repeat(10)), role).lastInsertRowid); return { cookie: "core_session=" + createSession(db, id) }; };
  const admin = mk("admin", "admin"), op = mk("op", "operator");
  const call = async (who: { cookie: string }, method: string, url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie: who.cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let json: any = null; try { json = JSON.parse(t); } catch { /* */ } return { status: r.status, json }; };
  return { db, sim, reg, gw, lic, admin, op, call };
}

test("over HTTP: sensors 1..10 are accepted, the 11th (single, or a pasted list that would pass 10) is refused with the limit message and 409; nothing is half-added", async () => {
  const x = await boot(); const body = (n: number[]) => ({ type: "th", serials: n.map(ser) });
  for (let i = 1; i <= 9; i++) assert.equal((await x.call(x.admin, "POST", "/api/sensors", body([i]))).status, 200);
  assert.equal((await x.call(x.admin, "POST", "/api/sensors", body([10, 11]))).status, 409, "a pasted list that would pass the limit is refused as a whole"); assert.equal(usage(x.db).sensors, 9);
  assert.equal((await x.call(x.admin, "POST", "/api/sensors", body([10]))).status, 200);
  const r = await x.call(x.admin, "POST", "/api/sensors", body([11])); assert.equal(r.status, 409); assert.equal(r.json.error, LIMIT_MSG); assert.equal(r.json.code, "LICENCE_LIMIT"); assert.equal(usage(x.db).sensors, 10);
  assert.equal((await x.call(x.op, "POST", "/api/sensors", body([12]))).status, 403, "an Operator never gets as far as the limit");
});
test("over the limit nothing stops: the gateway keeps being polled, alarms are computed, pump commands work, removing frees room; ADD stays blocked until under the limit", async () => {
  const x = await boot(); for (let i = 1; i <= 12; i++) x.db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at) VALUES(?,?,?,5,1)").run(ser(i), "th", i);       // an older install with 12
  assert.equal(x.lic.summary().over_limit, true); const lastOk0 = x.gw.lastOk;
  let t = Date.now(); for (let i = 0; i < 2; i++) { t += 60_000; x.sim.tick(t); await x.gw.pollNow(t); }
  assert.ok(x.gw.online && x.gw.lastOk !== null && x.gw.lastOk !== lastOk0, "the gateway is still polled every cycle"); assert.equal(usage(x.db).sensors, 12);
  assert.equal((await x.call(x.op, "GET", "/api/alarms")).status, 200); assert.equal((await x.call(x.op, "GET", "/api/scada")).status, 200);
  assert.equal((await x.call(x.op, "POST", "/api/commands", { pump: "pump1", action: "on" })).status, 200, "pump command"); assert.equal((await x.call(x.admin, "PATCH", `/api/sensors/${ser(1)}`, { label: "edit works" })).status, 200);
  assert.equal((await x.call(x.admin, "POST", "/api/sensors", { type: "th", serials: [ser(50)] })).status, 409);
  assert.equal((await x.call(x.admin, "DELETE", `/api/sensors/${ser(12)}`)).status, 200); assert.equal((await x.call(x.admin, "DELETE", `/api/sensors/${ser(11)}`)).status, 200); assert.equal(usage(x.db).sensors, 10);
  assert.equal((await x.call(x.admin, "POST", "/api/sensors", { type: "th", serials: [ser(50)] })).status, 409, "10 of 10: still no room"); assert.equal((await x.call(x.admin, "DELETE", `/api/sensors/${ser(10)}`)).status, 200); assert.equal((await x.call(x.admin, "POST", "/api/sensors", { type: "th", serials: [ser(50)] })).status, 200);
});
test("SEND TO GATEWAY: refused while unsent sensors would go beyond the limit, allowed once everything is under it (interval changes of sent sensors are never blocked)", async () => {
  const x = await boot(); await x.gw.pollNow(); for (let i = 1; i <= 12; i++) x.db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at) VALUES(?,?,?,5,1)").run(ser(i), "th", i);
  const r = await x.call(x.admin, "POST", "/api/gateway/sync", { types: ["th"], confirm: true }); assert.equal(r.status, 409); assert.equal(r.json.error, LIMIT_MSG);
  x.db.prepare("DELETE FROM sensors WHERE serial IN (?,?)").run(ser(11), ser(12)); const ok = await x.call(x.admin, "POST", "/api/gateway/sync", { types: ["th"], confirm: true }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
  x.lic.checkSend(11, 0);                                                                                                                                                                  // above the limit but nothing new to push: allowed
});
test("restore (import) cannot bring in more sensors than the limit; a backup of what the box already holds restores fine; the refusal names the About page", async () => {
  const x = await boot(); x.reg.add(A, "th", [1, 2, 3].map(ser)); const backup = (await x.call(x.admin, "GET", "/api/backup")).json;
  const big = { ...backup, sensors: [...backup.sensors, ...Array.from({ length: 9 }, (_, i) => ({ serial: ser(100 + i), type: "th", label: "", zone_id: null, slot: 10 + i, reporting_interval: 5, created_at: 1, replaced_by: null, thresholds: null }))] };
  const bad = await x.call(x.admin, "POST", "/api/backup/restore", big); assert.equal(bad.status, 409); assert.equal(bad.json.error, LIMIT_MSG); assert.equal(usage(x.db).sensors, 3, "nothing was replaced");
  assert.equal((await x.call(x.admin, "POST", "/api/backup/restore", backup)).status, 200);
});
test("UI wiring (source): Sensors header usage line 'SENSORS n of m · TYPE' with a link to About, OVER LIMIT chip, Add dialog pre-check and OPEN ABOUT", async () => {
  const { readFileSync } = await import("node:fs"); const sp = readFileSync("web/src/SensorsPage.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8");
  assert.match(sp, /SENSORS \{lic\.usage\.sensors\} of \{lic\.limits\.sensors\} · \{licWord\(lic\)\}/); assert.match(sp, /go\("\/about"\)\}>ABOUT</); assert.match(sp, /OVER LIMIT/); assert.match(sp, /OPEN ABOUT/); assert.match(sp, /Upload a licence on the About page\./);
  for (const k of ["DROP LICENCE FILE HERE", "CHOOSE FILE", "APPLY LICENCE", "REMOVE LICENCE", "Admin only. One licence file works on one box. Every licence change is written to the audit log."]) assert.ok(ab.includes(k), k);
  assert.match(ab, /disabled=\{!file \|\| !!look \|\| busy\}/); assert.match(readFileSync("web/src/about.css", "utf8"), /\.ab-apply \{ min-height: 56px/); assert.match(ab, /\{admin && <Upload/);
});
