import "./isolate.js";   // test data folder is a temp dir
// 2026-11-19 -- Server Connection, BOX side (core-server-connection-spec.md, "Tests"). No real network: a fake `fetch` plays the main server, so every case is deterministic.
// Covers: valid report at the interval; the scan test (no NEVER SENT data, no access key); backoff and lamp states for unreachable / TLS failure / 401 / 429 / slow server;
// monitoring unaffected while the server hangs; key never returned and stored encrypted; code enrolment, approval wait, rejection; FREE reports; Operator gets nothing; standalone without network.
import test, { after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js"; import { ServerLink, backoffS, cleanAddress, describeError, BACKOFF_S } from "../src/serverlink/client.js"; import { buildReport, REPORT_MAX_BYTES } from "../src/serverlink/report.js";
import { freeSummary, type LicenceSummary } from "../src/licence/summary.js"; import { hashPassword } from "../src/auth.js"; import { rig } from "./rig.js";

const closers: (() => unknown)[] = []; after(() => closers.forEach((c) => c()));
const KEY = "K3y_" + "a1B2c3D4e5F6g7H8".repeat(2) + "_SECRET";          // 36 chars of [A-Za-z0-9_-]
const ID = "FP-48F1-40C7-092D", ADMIN = { username: "admin", role: "admin" };
type Call = { url: string; init: any; body: any };
/** A fake main server. `handler` decides each answer; every request is kept for inspection. */
function fakeServer(handler: (c: Call, n: number) => { status?: number; json?: any; throw?: any; hang?: boolean } = () => ({ json: { ok: true, server_time: new Date().toISOString(), next_in_s: 60 } })) {
  const calls: Call[] = [];
  const f = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null }; calls.push(c); const r = handler(c, calls.length);
    if (r.hang) { const keep = setTimeout(() => {}, 10_000);   // AbortSignal.timeout() is unref'd: without a ref'd handle the test process would think nothing is pending
      try { await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })))); } finally { clearTimeout(keep); } }
    if (r.throw) throw r.throw;
    const status = r.status ?? 200; return new Response(JSON.stringify(r.json ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch; return { f, calls };
}
const mkLink = (opts: { fetchFn?: any; licence?: () => LicenceSummary; deviceId?: () => string | null; db?: any; now?: () => number; timeoutMs?: number; firstDelayMs?: number } = {}) => {
  const db = opts.db ?? openDb(":memory:");
  const link = new ServerLink({ db, licence: opts.licence ?? (() => freeSummary(db)), deviceId: opts.deviceId ?? (() => ID), version: () => ({ version: "0.3.0", build: "f1e73e8" }), os: () => "Linux test", fetchFn: opts.fetchFn, now: opts.now, timeoutMs: opts.timeoutMs, firstDelayMs: opts.firstDelayMs, defaultName: () => "TEST FARM" });
  closers.push(() => link.stop()); return { db, link };
};
const enable = (link: ServerLink, key = KEY) => { link.save(ADMIN, { enabled: true, address: "https://core.example.com", box_name: "BENCH", interval_s: 60 }); link.store.setKey(key); link.store.put("enrol_state", "approved"); };
const tick = () => new Promise((r) => setImmediate(r));

test("a valid version 1 report goes out with the right headers, only to the verified HTTPS address, and 'send now' does not change settings", async () => {
  const s = fakeServer(); const { link } = mkLink({ fetchFn: s.f }); enable(link); const before = JSON.stringify(link.settings());
  const r = await link.sendNow(); assert.equal(r.ok, true); assert.equal(s.calls.length, 1); const c = s.calls[0];
  assert.equal(c.url, "https://core.example.com/api/fleet/report"); assert.equal(c.init.method, "POST"); assert.equal(c.init.headers["x-device-id"], ID); assert.equal(c.init.headers.authorization, "Bearer " + KEY); assert.equal(c.init.redirect, "error");
  const b = c.body; assert.equal(b.v, 1); assert.equal(b.device_id, ID); assert.equal(b.box_name, "BENCH"); assert.equal(b.report_no, 1); assert.equal(b.interval_s, 60); assert.equal(b.version, "0.3.0"); assert.equal(b.build, "f1e73e8");
  assert.match(b.sent_at, /^\d{4}-\d\d-\d\dT.*Z$/); assert.ok(["service", "console", "systemd"].includes(b.runs_as)); assert.equal(b.licence.type, "FREE"); assert.equal(b.licence.state, "FREE"); assert.equal(b.licence.valid_until, null);
  assert.deepEqual(Object.keys(b.usage), ["data_sources", "sensors"]); assert.equal(b.usage.sensors.max, 10, "FREE has 10 sensors"); assert.ok(Buffer.byteLength(c.init.body) <= REPORT_MAX_BYTES);
  assert.equal(JSON.stringify(link.settings()), before.replace('"report_no":0', '"report_no":1'), "only the report counter moved"); assert.equal((await link.sendNow()).ok, true); assert.equal(s.calls[1].body.report_no, 2);
});

test("scheduling: the first report after start, then one per interval (never more, nothing queued)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = fakeServer(); const { link } = mkLink({ fetchFn: s.f, firstDelayMs: 5000 }); enable(link); link.start();
  t.mock.timers.tick(4999); await tick(); assert.equal(s.calls.length, 0); t.mock.timers.tick(2); await tick(); await tick(); assert.equal(s.calls.length, 1, "first report");
  t.mock.timers.tick(59_000); await tick(); assert.equal(s.calls.length, 1); t.mock.timers.tick(1500); await tick(); await tick(); assert.equal(s.calls.length, 2, "second report one interval later");
  link.save(ADMIN, { interval_s: 900 }); assert.equal(link.nextDelayMs(), 900_000, "interval is applied at once"); link.stop(); t.mock.timers.tick(10 * 60_000); await tick(); assert.equal(s.calls.length, 2, "stopped means silent");
});

test("SCAN: the report holds none of the NEVER SENT data and no access key (users, passwords, contacts, farm logo, notes, readings, serials)", async () => {
  const db = openDb(":memory:"), s = fakeServer(); const { link } = mkLink({ fetchFn: s.f, db });
  // everything that must NEVER leave the box, each with a unique sentinel
  db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES('sentinel_user_ann',?,'admin',1)").run(hashPassword("Sentinel-Passw0rd-XYZ"));
  db.prepare("INSERT INTO farm_profile(id,farm_name,site_name,owner_name,notes,logo,logo_type,logo_hash,address,timezone) VALUES(1,'Sentinel Farm Name','SENTINEL_SITE','SENTINEL_OWNER','SENTINEL_NOTE_TEXT',x'89504e47',?,'SENTINEL_LOGO_HASH','SENTINEL_ADDRESS','Asia/Dubai')").run("image/png");
  db.prepare("INSERT INTO farm_contacts(name,phone,email,created_at) VALUES('SENTINEL_CONTACT','+971500000SENT','sentinel@contact.example',1)").run();
  db.prepare("INSERT INTO sensors(serial,type,label,reporting_interval,created_at) VALUES('SERIAL987654321','th','SENTINEL_SENSOR_LABEL',5,1)").run();
  db.prepare("INSERT INTO series(id,topic,sensor_key,metric) VALUES(1,'gateway/th','SERIAL987654321','temperature')").run(); db.prepare("INSERT INTO latest(series_id,value,ts) VALUES(1,31.7654321,?)").run(Date.now() - 5000);
  db.prepare("INSERT INTO alarm_events(kind,source,severity,text,raised_at) VALUES('low_battery','SERIAL987654321','warning','SENTINEL_ALARM_TEXT',?)").run(Date.now());
  enable(link); assert.equal((await link.sendNow()).ok, true);
  const raw = s.calls[0].init.body as string, b = s.calls[0].body;
  const allowed = ["v", "device_id", "box_name", "report_no", "sent_at", "interval_s", "version", "build", "os", "runs_as", "uptime_s", "licence", "usage", "last_data_at", "active_alarms"];
  assert.deepEqual(Object.keys(b).sort(), allowed.sort(), "exactly the version 1 fields"); assert.deepEqual(Object.keys(b.licence).sort(), ["state", "type", "valid_until"]);
  for (const w of ["sentinel", "SENTINEL", "Sentinel", "SERIAL987654321", "31.7654", "pass_hash", "scrypt", "+971500000SENT", "@contact.example", KEY, "K3y_", "password", "logo", "notes", "contact", "latitude"]) assert.ok(!raw.includes(w), `the report contains "${w}"`);
  assert.equal(b.active_alarms, 1, "a COUNT of open alarms is sent, not their text"); assert.equal(typeof b.last_data_at, "string", "a TIMESTAMP of the newest reading is sent, not its value"); assert.ok(!/"(temperature|humidity|value|readings|users)"/.test(raw));
  assert.equal(s.calls[0].init.headers.authorization, "Bearer " + KEY, "the key travels only in the Authorization header"); assert.ok(!JSON.stringify(s.calls[0].init.headers).replace(/"authorization":"Bearer [^"]+"/, "").includes(KEY));
  // however large the inputs, the report stays under 4 KB (every free-text field is clipped)
  const big = buildReport({ deviceId: ID, boxName: "n".repeat(5000), reportNo: 1, now: 0, intervalS: 60, version: "v".repeat(500), build: "b".repeat(500), os: "o".repeat(5000), runsAs: "console", uptimeS: 1, licence: { ...freeSummary(db), type: "T".repeat(900) }, lastDataAt: null, activeAlarms: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= REPORT_MAX_BYTES); assert.equal(big.box_name.length, 64);
});

test("backoff 60 s, 2 min, 5 min, then every 15 min; success returns to the interval; lamp states follow", async () => {
  assert.deepEqual(BACKOFF_S, [60, 120, 300, 900]); assert.deepEqual([1, 2, 3, 4, 5, 20].map(backoffS), [60, 120, 300, 900, 900, 900]);
  let up = false; const s = fakeServer(() => (up ? { json: { ok: true, server_time: new Date().toISOString() } } : { throw: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) }));
  const { link } = mkLink({ fetchFn: s.f }); enable(link);
  assert.equal(link.status().state, "CONNECTING", "enrolled, nothing sent yet"); const seen: [string, number][] = [];
  for (let i = 0; i < 5; i++) { const r = await link.sendNow(); assert.equal(r.ok, false); assert.equal(r.message, "server name not found"); seen.push([link.status().state, link.nextDelayMs() / 1000]); }
  assert.deepEqual(seen, [["CONNECTING", 60], ["CONNECTING", 120], ["NOT_REACHABLE", 300], ["NOT_REACHABLE", 900], ["NOT_REACHABLE", 900]], "3 failures = NOT REACHABLE");
  up = true; assert.equal((await link.sendNow()).ok, true); assert.equal(link.status().state, "CONNECTED"); assert.equal(link.nextDelayMs(), 60_000); assert.equal(link.status().reports_today.failed, 5);
});

test("TLS failure, 401 (revoked), 429, slow server: each is a failed contact with a plain reason and the right lamp state", async () => {
  const tls = fakeServer(() => ({ throw: Object.assign(new TypeError("fetch failed"), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }) })); let m = mkLink({ fetchFn: tls.f }); enable(m.link);
  assert.equal((await m.link.sendNow()).message, "certificate not accepted"); assert.equal(describeError(Object.assign(new Error("x"), { cause: { code: "CERT_HAS_EXPIRED" } })), "certificate not accepted");
  const r401 = fakeServer(() => ({ status: 401, json: { error: "access key not accepted" } })); m = mkLink({ fetchFn: r401.f }); enable(m.link); const a = await m.link.sendNow();
  assert.equal(a.ok, false); assert.equal(a.http, 401); const st = m.link.status(); assert.equal(st.state, "NOT_REACHABLE", "revoked: NOT REACHABLE on the FIRST 401"); assert.match(st.reason!, /access revoked/); assert.equal(m.link.nextDelayMs(), 60_000);
  const r429 = fakeServer(() => ({ status: 429, json: {} })); m = mkLink({ fetchFn: r429.f }); enable(m.link); assert.equal((await m.link.sendNow()).message, "server is limiting this box"); assert.equal(m.link.status().state, "CONNECTING"); assert.equal(m.link.nextDelayMs(), 60_000);
  const slow = fakeServer(() => ({ hang: true })); m = mkLink({ fetchFn: slow.f, timeoutMs: 60 }); enable(m.link); const t0 = Date.now(); const z = await m.link.sendNow(); assert.equal(z.message, "no answer in time"); assert.ok(Date.now() - t0 < 1500);
  const html = fakeServer(() => ({ status: 200, json: { not: "ours" } })); m = mkLink({ fetchFn: html.f }); enable(m.link); assert.equal((await m.link.sendNow()).ok, false, "a 200 without ok:true is not a success");
});

test("plain HTTP and odd addresses are refused: HTTPS only, no credentials, no path", () => {
  assert.equal(cleanAddress("https://core.farm-pilot.com/"), "https://core.farm-pilot.com"); assert.equal(cleanAddress(" https://Core.Example.com:8443 "), "https://core.example.com:8443");
  for (const bad of ["http://core.farm-pilot.com", "ftp://x.y", "core.farm-pilot.com", "https://u:p@core.example.com", "https://core.example.com/api", "https://core.example.com/?x=1", "", "https://" + "a".repeat(300) + ".com"]) assert.throws(() => cleanAddress(bad), undefined, bad);
  const { link } = mkLink(); assert.throws(() => link.save(ADMIN, { address: "http://core.example.com" }), /https/); assert.throws(() => link.save(ADMIN, { interval_s: 7 }), /1, 5 or 15/); assert.throws(() => link.save(ADMIN, { box_name: "" }), /Box name/);
  for (const n of [60, 300, 900]) assert.equal(link.save(ADMIN, { interval_s: n }).interval_s, n);
});

test("ISOLATION: a server that never answers, throws or lies cannot slow the poll loop, a route or the event loop", async () => {
  const hang = fakeServer(() => ({ hang: true })), { link } = mkLink({ fetchFn: hang.f, timeoutMs: 700 }); enable(link);
  const r = await rig({ link }); closers.push(() => void r.close());
  // stand-in for the gateway poll loop / alarm tracker: a 10 ms ticker whose worst gap we measure while a report hangs
  let ticks = 0, worst = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; ticks++; }, 10);
  const pending = link.sendNow(); await tick(); assert.equal(link.status().busy, true, "the request is in flight");
  const t0 = performance.now(); for (let i = 0; i < 5; i++) assert.equal((await r.call(r.admin, "GET", "/api/health")).status, 200); const routeMs = performance.now() - t0;
  assert.equal((await r.call(r.admin, "GET", "/api/about")).status, 200); assert.equal((await r.call(r.admin, "GET", "/api/server-connection")).status, 200, "the page itself stays responsive while sending");
  assert.equal((await r.call(r.admin, "GET", "/api/state")).status, 200); assert.equal((await r.call(r.admin, "GET", "/api/control")).status, 200);
  await new Promise((x) => setTimeout(x, 300)); assert.equal(link.status().busy, true, "still hanging"); clearInterval(iv);
  assert.ok(ticks >= 25, `poll loop ticked ${ticks} times in 300+ ms`); assert.ok(worst < 120, `worst gap between poll ticks ${worst.toFixed(0)} ms`); assert.ok(routeMs < 800, `routes answered in ${routeMs.toFixed(0)} ms`);
  assert.equal((await pending).message, "no answer in time"); assert.equal(link.status().busy, false);
  // everything inside the client is caught: a failing licence read, a failing deviceId and a failing fetch all resolve as FAILED contacts
  for (const bad of [{ licence: () => { throw new Error("licence boom"); } }, { fetchFn: (() => { throw new Error("sync fetch boom"); }) as any }, { fetchFn: (async () => { throw new Error("async fetch boom"); }) as any }]) {
    const m = mkLink(bad as any); enable(m.link); const x = await m.link.sendNow(); assert.equal(x.ok, false); assert.equal(typeof x.message, "string");
  }
  // wiring: index.ts arms the timer and never awaits the link
  const idx = readFileSync("src/index.ts", "utf8"); assert.match(idx, /^serverLink\.start\(\);$/m); assert.ok(!/await\s+serverLink/.test(idx), "index.ts must never await the server link");
  const cl = readFileSync("src/serverlink/client.ts", "utf8"); assert.ok(!/\.listen\(|createServer\(|WebSocket/.test(cl.replace(/\/\/.*$/gm, "")), "the client opens no listening socket and no WebSocket");
});

test("the access key is stored encrypted and is never returned by any API, diagnostics or bundle", async () => {
  const s = fakeServer(), { db, link } = mkLink({ fetchFn: s.f }); const r = await rig({ db, link }); closers.push(() => void r.close()); enable(link);
  const raw = (db.prepare("SELECT value v FROM settings WHERE key='sl.key_enc'").get() as { v: string }).v; assert.match(raw, /^v1:/); assert.ok(!raw.includes(KEY)); assert.equal(link.store.key(), KEY, "and it decrypts for the one place that sends it");
  const dump = JSON.stringify(db.prepare("SELECT * FROM settings").all()); assert.ok(!dump.includes(KEY));
  await r.call(r.admin, "POST", "/api/server-connection/send-now");
  const bodies: string[] = [];
  for (const [m, u, b] of [["GET", "/api/server-connection"], ["PUT", "/api/server-connection", { box_name: "X1" }], ["POST", "/api/server-connection/send-now"], ["POST", "/api/server-connection/test", {}], ["GET", "/api/about"], ["GET", "/api/diagnostics"], ["GET", "/api/backup"], ["GET", "/api/support-bundle"], ["GET", "/api/audit"]] as const) {
    const x = await r.call(r.admin, m, u, b as any); bodies.push(x.txt + Buffer.from(x.buf).toString("latin1")); }
  for (const t of bodies) { assert.ok(!t.includes(KEY), "key in an answer"); assert.ok(!/key_enc|access_key|"key"/i.test(t.replace(/"key":"(?:gw|cal)\./g, "")), "no key field either"); }
  const log = JSON.stringify(db.prepare("SELECT * FROM audit_log").all()); assert.ok(!log.includes(KEY), "not in the audit log");
  const v = (await r.call(r.admin, "GET", "/api/server-connection")).json; assert.deepEqual(Object.keys(v).sort(), ["contacts", "settings", "status"]); assert.equal(v.status.enrolment, "APPROVED"); assert.ok(!("key_enc" in v.settings));
});

test("enrolment: a valid code stores the key; no code means WAITING FOR APPROVAL and the box asks again; rejection and bad codes are reported; every step is audited", async () => {
  let mode: "ok" | "pending" | "approved" | "rejected" | "bad" = "ok";
  const s = fakeServer((c) => mode === "pending" ? { status: 202, json: { ok: true, status: "pending" } } : mode === "approved" ? { json: { ok: true, status: "approved", access_key: KEY } } : mode === "rejected" ? { status: 403, json: { error: "this box was rejected", status: "rejected" } } : mode === "bad" ? { status: 403, json: { error: "enrolment code not valid or expired" } } : { json: { ok: true, status: "approved", access_key: KEY, server_time: new Date().toISOString() } });
  const { db, link } = mkLink({ fetchFn: s.f }); link.save(ADMIN, { enabled: true, address: "https://core.example.com", box_name: "BENCH" }); assert.equal(link.status().state, "NOT_ENROLLED"); assert.equal(link.status().enrolment, "NOT ENROLLED");
  mode = "bad"; let e = await link.enrol(ADMIN, "wrong-code"); assert.equal(e.ok, false); assert.match(e.message, /not valid or expired/); assert.equal(link.store.hasKey(), false);
  assert.equal((await link.enrol(ADMIN, "bad code!!")).ok, false, "a malformed code never leaves the box");
  mode = "ok"; e = await link.enrol(ADMIN, "4k7-92mq"); assert.equal(e.ok, true); assert.equal(s.calls.at(-1)!.url, "https://core.example.com/api/fleet/enrol"); assert.deepEqual(Object.keys(s.calls.at(-1)!.body).sort(), ["code", "device_id", "name", "v", "version"]); assert.equal(s.calls.at(-1)!.body.code, "4K7-92MQ");
  assert.equal(link.store.key(), KEY); assert.equal(link.status().enrolment, "APPROVED"); assert.equal(link.status().state, "CONNECTING");
  // new address = new server = enrol again
  link.save(ADMIN, { address: "https://other.example.com" }); assert.equal(link.store.hasKey(), false); assert.equal(link.status().state, "NOT_ENROLLED");
  mode = "pending"; e = await link.enrol(ADMIN, ""); assert.equal(e.state, "WAITING FOR APPROVAL"); assert.equal(link.status().enrolment, "WAITING FOR APPROVAL"); assert.match(link.status().reason!, /approve/); assert.ok(!("code" in s.calls.at(-1)!.body));
  mode = "approved"; e = await link.enrol(ADMIN, ""); assert.equal(e.ok, true); assert.equal(link.status().enrolment, "APPROVED");
  link.save(ADMIN, { address: "https://third.example.com" }); mode = "rejected"; e = await link.enrol(ADMIN, ""); assert.equal(e.state, "REJECTED"); assert.equal(link.status().enrolment, "REJECTED");
  const acts = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'server_link.%' ORDER BY id").all() as { action: string }[]).map((x) => x.action); for (const a of ["server_link.settings", "server_link.enrol", "server_link.enrol_requested"]) assert.ok(acts.includes(a), a);
  assert.ok(!JSON.stringify(db.prepare("SELECT detail FROM audit_log").all()).includes(KEY));
});

test("pending enrolment: the box asks again on its own timer until the server approves, then reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let approved = false;
  const s = fakeServer((c) => c.url.endsWith("/enrol") ? (approved ? { json: { ok: true, access_key: KEY } } : { status: 202, json: { status: "pending" } }) : { json: { ok: true, server_time: new Date().toISOString() } });
  const { link } = mkLink({ fetchFn: s.f, firstDelayMs: 1000 }); link.save(ADMIN, { enabled: true, address: "https://core.example.com" }); await link.enrol(ADMIN, ""); link.start();
  t.mock.timers.tick(1100); await tick(); await tick(); assert.equal(s.calls.filter((c) => c.url.endsWith("/enrol")).length, 2, "asked again"); assert.equal(s.calls.filter((c) => c.url.endsWith("/report")).length, 0);
  approved = true; t.mock.timers.tick(61_000); await tick(); await tick(); assert.equal(link.status().enrolment, "APPROVED"); t.mock.timers.tick(61_000); await tick(); await tick(); assert.ok(s.calls.some((c) => c.url.endsWith("/report")), "then it reports");
});

test("clock difference: more than 2 minutes between the server time and this box shows a warning", async () => {
  for (const [offs, warn] of [[30, false], [-119, false], [5 * 60, true], [-10 * 60, true]] as const) {
    const s = fakeServer(() => ({ json: { ok: true, server_time: new Date(Date.now() + offs * 1000).toISOString() } })); const { link } = mkLink({ fetchFn: s.f }); enable(link); await link.sendNow();
    assert.equal(link.status().clock_warning, warn, `${offs} s`); assert.ok(Math.abs(link.status().clock_diff_s! - offs) <= 2);
  }
});

test("TEST CONNECTION reaches the health address only: no report, nothing stored, settings untouched; a bad address is refused", async () => {
  const s = fakeServer((c) => ({ json: { ok: true, version: "x" } })), { db, link } = mkLink({ fetchFn: s.f }); link.save(ADMIN, { address: "https://core.example.com" }); const before = JSON.stringify([link.settings(), db.prepare("SELECT * FROM settings").all()]);
  const a = await link.test(); assert.equal(a.ok, true); assert.equal(s.calls[0].url, "https://core.example.com/api/health"); assert.equal(s.calls[0].init.method, undefined); assert.equal(s.calls[0].init.headers.authorization, undefined, "no key is sent");
  assert.equal((await link.test("https://other.example.com")).ok, true); assert.equal(s.calls[1].url, "https://other.example.com/api/health"); assert.equal((await link.test("http://plain.example.com")).ok, false); assert.equal(s.calls.length, 2);
  assert.equal(JSON.stringify([link.settings(), db.prepare("SELECT * FROM settings").all()]), before); assert.equal(link.store.recent().length, 0, "a test is not a contact");
});

test("FREE reports too: reporting is not licence gated; an EXPIRED or INVALID box also reports its state", async () => {
  for (const state of ["FREE", "EXPIRED", "INVALID", "LICENSED"] as const) {
    const s = fakeServer(), db = openDb(":memory:"), base = freeSummary(db); const lic: LicenceSummary = { ...base, state, type: state === "LICENSED" ? "PRO" : "FREE", valid_until: state === "LICENSED" ? "2027-11-18T23:59:59Z" : null };
    const { link } = mkLink({ fetchFn: s.f, db, licence: () => lic }); enable(link); assert.equal((await link.sendNow()).ok, true, state); assert.equal(s.calls[0].body.licence.state, state);
    if (state === "LICENSED") { assert.equal(s.calls[0].body.licence.type, "PRO"); assert.equal(s.calls[0].body.licence.valid_until, "2027-11-18T23:59:59Z"); }
  }
  assert.ok(!/licen[cs]e|tier|FREE|gate/i.test(readFileSync("src/serverlink/routes.ts", "utf8").replace(/\/\/.*$/gm, "")), "no licence check in the Server Connection routes");
});

test("disabled, not enrolled, no Device ID, and a standalone box without any network: states are right and nothing else breaks", async () => {
  const net = fakeServer(() => ({ throw: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } }) })), { db, link } = mkLink({ fetchFn: net.f }); const r = await rig({ db, link }); closers.push(() => void r.close());
  let st = (await r.call(r.admin, "GET", "/api/server-connection")).json.status; assert.equal(st.state, "DISABLED"); assert.equal(st.enrolment, "NOT ENROLLED");
  assert.equal((await r.call(r.admin, "PUT", "/api/server-connection", { enabled: true })).json.status.state, "NOT_ENROLLED"); assert.equal((await r.call(r.admin, "POST", "/api/server-connection/send-now")).json.ok, false, "refuses, does not call out"); assert.equal(net.calls.length, 0);
  link.store.setKey(KEY); link.store.put("enrol_state", "approved"); for (let i = 0; i < 3; i++) await r.call(r.admin, "POST", "/api/server-connection/send-now");
  st = (await r.call(r.admin, "GET", "/api/server-connection")).json.status; assert.equal(st.state, "NOT_REACHABLE"); assert.match(st.reason, /no route/);
  for (const u of ["/api/health", "/api/state", "/api/control", "/api/about"]) assert.equal((await r.call(r.admin, "GET", u)).status, 200, u);
  assert.equal((await r.call(r.admin, "PUT", "/api/server-connection", { enabled: false })).json.status.state, "DISABLED");
  const nid = mkLink({ deviceId: () => null, fetchFn: net.f }); enable(nid.link); const x = await nid.link.sendNow(); assert.match(x.message, /no Device ID/); assert.equal(net.calls.length, 3, "nothing was sent without a Device ID");
});

test("About: MAIN CORE SERVER data for Admin only; an Operator gets no server_link field, no card, and 403 on every Server Connection route", async () => {
  const s = fakeServer(), { link } = mkLink({ fetchFn: s.f }); const r = await rig({ link }); closers.push(() => void r.close()); enable(link); await link.sendNow();
  const a = (await r.call(r.admin, "GET", "/api/about")).json; assert.equal(a.server_link.state, "CONNECTED"); assert.equal(a.server_link.host, "core.example.com"); assert.deepEqual(a.server_link.reports_today, { ok: 1, failed: 0 }); assert.equal(a.server_link.enrolment, "APPROVED");
  assert.deepEqual(Object.keys(a.server_link).sort(), ["clock_warning", "enrolment", "host", "last_contact_at", "reason", "reports_today", "round_trip_ms", "state"]);
  const o = await r.call(r.op, "GET", "/api/about"); assert.equal(o.status, 200); assert.ok(!("server_link" in o.json)); assert.ok(!/server_link|core\.example\.com|MAIN CORE/i.test(o.txt));
  for (const [m, u, b] of [["GET", "/api/server-connection", undefined], ["PUT", "/api/server-connection", {}], ["POST", "/api/server-connection/enrol", {}], ["POST", "/api/server-connection/test", {}], ["POST", "/api/server-connection/send-now", {}]] as const) assert.equal((await r.call(r.op, m, u, b)).status, 403, `${m} ${u} as Operator`);
  assert.equal((await r.call(null, "GET", "/api/server-connection")).status, 401);
  // UI wiring (source checks, same style as menu.test.ts): the card sits inside the Admin block, between LICENCE and THIS COMPUTER; the page route is Admin only
  const ab = readFileSync("web/src/About.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8");
  assert.match(ab, /\{admin && info\.server_link && <ServerCard/); assert.ok(ab.indexOf('aria-label="Licence"') < ab.indexOf("<ServerCard") && ab.indexOf("<ServerCard") < ab.indexOf('aria-label="This computer"'), "MAIN CORE SERVER sits between LICENCE and THIS COMPUTER");
  assert.match(ab, /SEND NOW/); assert.match(ab, /OPEN SERVER CONNECTION/); assert.match(st, /t === "server-connection" \? <ServerConnectionPage/); assert.match(app, /me\.role !== "admin" && page === "settings" && rest\[0\] !== "mqtt-payload"\) go\("\/monitoring"\)/, "an Operator typing #/settings/server-connection lands on MONITORING");
});

test("the 20 most recent contacts are kept in order, today's counters count reports only, old rows are pruned", async () => {
  let t = Date.now(); const s = fakeServer((c, n) => (n % 4 === 0 ? { status: 500 } : { json: { ok: true, server_time: new Date().toISOString() } })); const { link } = mkLink({ fetchFn: s.f, now: () => (t += 1000) }); enable(link);
  for (let i = 0; i < 30; i++) await link.sendNow(); const c = link.store.recent(20); assert.equal(c.length, 20); assert.ok(c[0].ts > c[19].ts); assert.equal(c[0].report_no, 30); assert.equal(link.status().reports_today.ok + link.status().reports_today.failed, 30); assert.ok(link.status().reports_today.failed >= 7);
  link.store.addContact({ ts: t + 3 * 86400_000, ok: true, code: 200, error: null, rtt_ms: 1, report_no: 99, kind: "report" }); assert.equal((link.store.recent(500)).length, 1, "rows older than 2 days are dropped");
});
