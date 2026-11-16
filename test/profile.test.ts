// Farm Profile and contacts: validation, threshold precedence, permissions, logo, backup round trip, timing without restart.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import Fastify from "fastify"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js";
import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js";
import { Registry, HttpError } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { registerGatewayRoutes } from "../src/gateway/routes.js";
import { registerProfileRoutes } from "../src/gateway/profile-routes.js"; import { ProfileService, checkLogo, validateContact } from "../src/gateway/profile.js";
import { buildView } from "../src/gateway/health.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const A = { username: "admin", role: "admin" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
async function rig() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); closers.push(() => { void tr.close(); srv.close(); });
  const reg = new Registry(db, map); const svc = new GatewayService(db, reg, new Ingest(db), new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  const prof = new ProfileService(db, map);
  const app = Fastify(); app.decorateRequest("user", undefined as any);
  app.addHook("onRequest", async (req) => { (req as any).user = { id: 1, username: "u", role: String(req.headers["x-role"] ?? "admin") }; });
  const admin = async (req: any, reply: any) => { if (req.user?.role !== "admin") return reply.code(403).send({ error: "admin only" }); };
  registerProfileRoutes(app, prof, admin, () => {}); registerGatewayRoutes(app, db, reg, svc, admin, () => {}, prof); await app.ready(); closers.push(() => void app.close());
  await svc.pollNow();
  const call = async (method: string, url: string, payload?: unknown, role = "admin", headers: Record<string, string> = {}) => { const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { "x-role": role, ...headers } }); let body: any = null; try { body = r.json(); } catch { /* binary */ } return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers }; };
  return { db, sim, reg, svc, prof, call };
}

test("first start creates the default profile; Admin reads it, public subset has no private fields", async () => {
  const { call } = await rig(); const p = (await call("GET", "/api/farm-profile")).body;
  assert.equal(p.farm_name, "Demo Farm"); assert.equal(p.placeholder, true); assert.equal(p.temperature_unit, "C"); assert.equal(p.language, "en"); assert.equal(p.defaults.rssi_good, -90); assert.equal(p.stale_multiplier, null);
  const pub = (await call("GET", "/api/farm-profile/public", undefined, "operator")).body; assert.deepEqual(Object.keys(pub).sort(), ["date_format", "default_theme", "farm_name", "logo_url", "site_name", "temperature_unit", "time_format", "timezone"]);
  assert.equal(pub.site_name, "Demo Farm");                                                                                // site name falls back to the farm name
});
test("permissions: Operator gets 403 on profile, logo upload and contacts, but can read /public and the alarm view (no email)", async () => {
  const { call } = await rig();
  for (const [m, u] of [["GET", "/api/farm-profile"], ["PUT", "/api/farm-profile"], ["POST", "/api/farm-profile/logo"], ["DELETE", "/api/farm-profile/logo"], ["GET", "/api/farm-contacts"], ["POST", "/api/farm-contacts"], ["DELETE", "/api/farm-contacts/1"]]) assert.equal((await call(m, u, {}, "operator")).status, 403, `${m} ${u}`);
  assert.equal((await call("GET", "/api/farm-profile/public", undefined, "operator")).status, 200);
  await call("POST", "/api/farm-contacts", { name: "Sam", role: "Manager", phone: "+971 50 123 4567", email: "sam@example.com", notify_gateway_offline: true });
  await call("POST", "/api/farm-contacts", { name: "Lee", email: "lee@example.com", notify_low_battery: true });
  const v = (await call("GET", "/api/farm-contacts/alarm-view", undefined, "operator")).body;
  assert.deepEqual(v.gateway_offline, [{ name: "Sam", role: "Manager", phone: "+971 50 123 4567" }]); assert.deepEqual(v.low_battery, [{ name: "Lee", role: "", phone: "" }]); assert.deepEqual(v.no_update, []); assert.doesNotMatch(JSON.stringify(v), /@/);
});
test("validation: name length, GPS ranges and pairing, IANA zone, unit, multipliers, unknown fields; errors are reported per field", async () => {
  const { call } = await rig(); const bad = async (b: any, field: string) => { const r = await call("PUT", "/api/farm-profile", b); assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(field in r.body.fields, `${field} in ${JSON.stringify(r.body.fields)}`); };
  await bad({ farm_name: "" }, "farm_name"); await bad({ farm_name: "x".repeat(61) }, "farm_name"); await bad({ latitude: 91, longitude: 10 }, "latitude"); await bad({ latitude: 10, longitude: 181 }, "longitude"); await bad({ latitude: 10 }, "longitude");
  await bad({ timezone: "Mars/Olympus" }, "timezone"); await bad({ temperature_unit: "K" }, "temperature_unit"); await bad({ stale_multiplier: 0 }, "stale_multiplier"); await bad({ offline_multiplier: 2.5 }, "offline_multiplier");
  await bad({ rssi_good: -100, rssi_weak: -90 }, "rssi_weak"); await bad({ colour: "red" }, "colour"); await bad({ low_voltage_by_type: { th: 99 } }, "low_voltage_by_type"); await bad({ low_voltage_by_type: { nope: 3 } }, "low_voltage_by_type"); await bad({ time_format: "13" }, "time_format");
  const ok = await call("PUT", "/api/farm-profile", { farm_name: "  Green Acres ", latitude: 25.2, longitude: 55.3, timezone: "Asia/Dubai", temperature_unit: "F", time_format: "12" }); assert.equal(ok.status, 200); assert.equal(ok.body.farm_name, "Green Acres"); assert.equal(ok.body.placeholder, false);
  assert.equal((await call("GET", "/api/farm-profile/public", undefined, "operator")).body.farm_name, "Green Acres");
});
test("thresholds: profile over register-map default, RESET (null) falls back, changes apply without a restart; audit keeps old and new values", async () => {
  const { call, reg, db } = await rig(); assert.deepEqual([reg.settings().types.th.low_voltage, reg.settings().rssiGood, reg.settings().staleMultiplier], [3.2, -90, 3]);
  await call("PUT", "/api/farm-profile", { low_voltage_by_type: { th: 3.4 }, rssi_good: -80, rssi_weak: -100, stale_multiplier: 2, offline_multiplier: 4, calibration_due_days: 180 });
  const s = reg.settings(); assert.deepEqual([s.types.th.low_voltage, s.rssiGood, s.rssiPoor, s.staleMultiplier, s.offlineMultiplier, s.calDueWarnDays], [3.4, -80, -100, 2, 4, 180]);
  await call("PUT", "/api/farm-profile", { low_voltage_by_type: {}, rssi_good: null, stale_multiplier: null }); assert.deepEqual([reg.settings().types.th.low_voltage, reg.settings().rssiGood, reg.settings().staleMultiplier], [3.2, -90, 3]);
  const row = db.prepare("SELECT detail FROM audit_log WHERE action='farm_profile.update' ORDER BY id").all() as { detail: string }[]; const d = JSON.parse(row[0].detail); assert.equal(d.old.stale_multiplier, null); assert.equal(d.new.stale_multiplier, 2);
  assert.throws(() => reg.saveSettings(A, { rssiGood: -80 }), /Farm Profile/);                                          // the old Gateway-page fields moved
});
test("changing the stale multiplier changes the NO UPDATE timing without a restart", async () => {
  const { sim, reg, svc, prof, db } = await rig(); reg.add(A, "th", ["112600310"]); await svc.sync(A, ["th"], false);
  let t = Date.now(); for (let i = 0; i < 2; i++) { t += 300_000; sim.tick(t); await svc.pollNow(t); }
  sim.freeze("112600310"); for (let i = 0; i < 2; i++) { t += 300_000; sim.tick(t); await svc.pollNow(t); }
  const at = () => buildView(db, reg, svc, true, t + 1000).sensors[0].status;                                           // frozen for about 2 x 5 min
  assert.equal(at(), "ok", "2 intervals is inside 3"); prof.update(A, { stale_multiplier: 1 }); assert.equal(at(), "no_update", "multiplier 1 applies at once");
  prof.update(A, { stale_multiplier: 20 }); assert.equal(at(), "ok");
});
test("contacts: need a phone or an email, validated; CRUD audited", async () => {
  const { call, db } = await rig();
  assert.equal((await call("POST", "/api/farm-contacts", { name: "No way" })).status, 400); assert.equal((await call("POST", "/api/farm-contacts", { name: "", phone: "+971501234567" })).status, 400);
  assert.equal((await call("POST", "/api/farm-contacts", { name: "X", email: "not-an-email" })).status, 400); assert.equal((await call("POST", "/api/farm-contacts", { name: "X", phone: "abc" })).status, 400);
  const c = (await call("POST", "/api/farm-contacts", { name: "Sam", phone: "+971501234567", notify_no_update: true })).body; assert.equal(c.notify_no_update, 1);
  assert.equal((await call("PUT", `/api/farm-contacts/${c.id}`, { role: "Owner", notify_low_battery: true })).body.role, "Owner"); assert.equal((await call("DELETE", `/api/farm-contacts/${c.id}`)).status, 200); assert.equal((await call("DELETE", `/api/farm-contacts/${c.id}`)).status, 404);
  assert.deepEqual((db.prepare("SELECT action FROM audit_log WHERE action LIKE 'farm_contact.%' ORDER BY id").all() as any[]).map((r) => r.action), ["farm_contact.add", "farm_contact.update", "farm_contact.delete"]); assert.throws(() => validateContact({ name: "x" }), HttpError);
});
test("logo: PNG and SVG accepted, wrong type / bad magic / script SVG / too big refused; served as an image with a sandbox CSP; audit records the hash only", async () => {
  const { call, db } = await rig();
  assert.equal((await call("POST", "/api/farm-profile/logo", PNG, "admin", { "content-type": "image/png" })).status, 200); const r = await call("GET", "/api/farm-profile/logo");
  assert.equal(r.headers["content-type"], "image/png"); assert.match(String(r.headers["content-security-policy"]), /sandbox/); assert.equal(r.headers["x-content-type-options"], "nosniff"); assert.equal(Buffer.compare(r.raw, PNG), 0);
  assert.equal((await call("GET", "/api/farm-profile/public", undefined, "operator")).body.logo_url?.startsWith("/api/farm-profile/logo?v="), true);
  assert.equal((await call("POST", "/api/farm-profile/logo", Buffer.from("not a png"), "admin", { "content-type": "image/png" })).status, 400);
  assert.equal((await call("POST", "/api/farm-profile/logo", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "admin", { "content-type": "image/svg+xml" })).status, 400);
  assert.equal((await call("POST", "/api/farm-profile/logo", "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>", "admin", { "content-type": "image/svg+xml" })).status, 200);
  assert.equal((await call("POST", "/api/farm-profile/logo", Buffer.alloc(300 * 1024), "admin", { "content-type": "image/png" })).status, 413);
  assert.ok([400, 415].includes((await call("POST", "/api/farm-profile/logo", "GIF89a", "admin", { "content-type": "text/plain" })).status));
  assert.throws(() => checkLogo(Buffer.from("<svg onload='x()'></svg>"), "image/svg+xml"), HttpError); assert.equal((await call("DELETE", "/api/farm-profile/logo")).body.has_logo, false);
  const a = (db.prepare("SELECT detail FROM audit_log WHERE action='farm_profile.logo' ORDER BY id").all() as any[]).map((r) => r.detail); assert.ok(a.every((d) => /hash/.test(d) && !/base64/.test(d)));
});
test("backup export/import keeps profile, logo and contacts; the Admin must confirm the timezone afterwards; an invalid profile in a backup changes nothing", async () => {
  const { call, prof } = await rig();
  await call("PUT", "/api/farm-profile", { farm_name: "Green Acres", site_name: "North Site", timezone: "Asia/Dubai", rssi_good: -85 }); await call("POST", "/api/farm-profile/logo", PNG, "admin", { "content-type": "image/png" });
  await call("POST", "/api/farm-contacts", { name: "Sam", phone: "+971501234567", notify_gateway_offline: true });
  const b = (await call("GET", "/api/backup")).body; assert.ok(b.farm_profile.logo_base64); assert.equal(b.farm_contacts.length, 1);
  await call("PUT", "/api/farm-profile", { farm_name: "Other", timezone: "UTC", rssi_good: null }); await call("DELETE", "/api/farm-profile/logo"); await call("DELETE", `/api/farm-contacts/${b.farm_contacts[0].id}`);
  const bad = structuredClone(b); bad.farm_profile.timezone = "Nope/Zone"; assert.equal((await call("POST", "/api/backup/restore", bad)).status, 400); assert.equal(prof.get().farm_name, "Other");
  assert.equal((await call("POST", "/api/backup/restore", b)).status, 200);
  const p = (await call("GET", "/api/farm-profile")).body; assert.deepEqual([p.farm_name, p.site_name, p.timezone, p.rssi_good, p.has_logo, p.timezone_confirm_needed], ["Green Acres", "North Site", "Asia/Dubai", -85, true, true]);
  assert.equal((await call("GET", "/api/farm-contacts")).body.length, 1); assert.equal((await call("PUT", "/api/farm-profile", { timezone: "Asia/Dubai" })).body.timezone_confirm_needed, false);
});
test("delete-all confirmation uses the Farm Profile name", async () => {
  const { call } = await rig(); await call("PUT", "/api/farm-profile", { farm_name: "Green Acres" });
  assert.equal((await call("POST", "/api/gateway/delete-all", { confirmText: "Demo Farm" })).status, 400); assert.equal((await call("POST", "/api/gateway/delete-all", { confirmText: "Green Acres" })).status, 200);
});
