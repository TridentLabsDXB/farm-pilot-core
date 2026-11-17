import "./isolate.js";   // test data folder is a temp dir (the MQTT secret key file is created there, never in /var/lib/farmpilot-core)
// Data sources > MQTT Payload (spec core-mqtt-payload-page.md, tests section): mapping engine, topic validation, connect/disconnect/reconnect against a REAL broker (Aedes on a free port),
// TEST CONNECTION messages, new-device flow, password never in any API response, Admin only, menu position. No external network is used.
import test, { after } from "node:test"; import assert from "node:assert/strict";
import { createServer, type Server } from "node:net"; import { readFileSync } from "node:fs";
import mqtt from "mqtt"; import { Aedes } from "aedes";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { mapPayload, checkFilter, topicMatches, checkRules, getPath, type MapOptions } from "../src/mqtt/mapping.js";
import { MqttSourceService, backoffMs } from "../src/mqtt/service.js"; import { encryptSecret, decryptSecret } from "../src/mqtt/secret.js";
import { DEFAULT_RULES, DEFAULT_ID_PATH, DEFAULT_TS_PATH, DEFAULT_TOPICS, SERIES_TOPIC } from "../src/mqtt/defaults.js";
import { rig } from "./rig.js";

const O: MapOptions = { idPath: DEFAULT_ID_PATH, tsPath: DEFAULT_TS_PATH, rules: DEFAULT_RULES };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, what: string, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return; await sleep(40); } assert.fail("timed out waiting for: " + what); }
const closers: (() => Promise<void> | void)[] = []; after(async () => { for (const c of closers.reverse()) await c(); });

/** A real MQTT broker on a free loopback port that can be stopped and started again on the SAME port (for the reconnect test). */
async function broker(port = 0) {
  let aedes: Aedes, server: Server; const socks = new Set<any>();
  const start = async (p: number) => { aedes = await Aedes.createBroker(); server = createServer(aedes.handle); server.on("connection", (k) => { socks.add(k); k.on("close", () => socks.delete(k)); }); await new Promise<void>((r, j) => { server.once("error", j); server.listen(p, "127.0.0.1", r); }); return (server.address() as any).port as number; };
  const port0 = await start(port);
  const stop = async () => { await new Promise<void>((r) => { server.close(() => r()); for (const k of socks) k.destroy(); }); await new Promise<void>((r) => aedes.close(() => r())); };
  let up = true; closers.push(async () => { if (up) await stop(); });
  return { port: port0, stop: async () => { await stop(); up = false; }, restart: async () => { await start(port0); up = true; } };
}
async function publish(port: number, topic: string, payload: string) {
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0 }); await new Promise((r, j) => { c.once("connect", r); c.once("error", j); });
  await new Promise<void>((r) => c.publish(topic, payload, { qos: 1 }, () => r())); await new Promise<void>((r) => c.end(false, {}, () => r()));
}
async function boot(opts: { backoff?: (n: number) => number } = {}) {
  const db = openDb(":memory:"); const ingest = new Ingest(db); const mq = new MqttSourceService(db, ingest, opts); const x = await rig({ db, mq });
  closers.push(async () => { await mq.stop(); await x.close(); });
  const get = async () => (await x.call(x.admin, "GET", "/api/mqtt")).json;
  return { ...x, mq, ingest, get };
}
const local = (port: number) => ({ host: "127.0.0.1", port, tls: false, client_id: "", username: "", keepalive: 30 });

// ---------------------------------------------------------------- mapping engine
test("Mapping: a valid payload becomes measurements with unit, scale and offset", () => {
  const r = mapPayload(JSON.stringify({ id: "A1", ts: "2026-11-18T10:00:00Z", t: 24.5, h: 61, bat: 88, rssi: -71 }), O);
  assert.equal(r.status, "ok"); assert.equal(r.deviceId, "A1"); assert.equal(r.ts, Date.parse("2026-11-18T10:00:00Z")); assert.deepEqual(r.errors, []);
  assert.deepEqual(r.values.map((v) => [v.name, v.unit, v.value]), [["temperature", "°C", 24.5], ["humidity", "%", 61], ["battery", "%", 88], ["rssi", "dBm", -71]]);
  const s = mapPayload(JSON.stringify({ id: 7, raw: { t: 100 } }), { ...O, rules: [{ path: "raw.t", name: "temperature", unit: "°C", scale: 0.1, offset: -2 }] });   // nested path, numeric id, scale and offset
  assert.equal(s.deviceId, "7"); assert.ok(Math.abs(s.values[0].value - 8) < 1e-9);
});
test("Mapping: a missing field is noted, not an error; fields no rule covers are listed as unmapped", () => {
  const r = mapPayload(JSON.stringify({ id: "A1", t: 20, extra: 1, nested: { a: 2 } }), O);
  assert.deepEqual(r.missing.sort(), ["bat", "h", "rssi"]); assert.deepEqual(r.errors, []); assert.deepEqual(r.unmapped.sort(), ["extra", "nested.a"]); assert.equal(r.status, "unmapped"); assert.equal(r.values.length, 1);
  assert.equal(mapPayload(JSON.stringify({ id: "A1", t: 20 }), O).status, "ok", "missing alone (a short status message) is fine");
});
test("Mapping: a wrong type is an error for that field only; the other fields still map", () => {
  const r = mapPayload(JSON.stringify({ id: "A1", t: "hot", h: 50, bat: null, rssi: [1] }), O);
  assert.equal(r.status, "error"); assert.equal(r.errors.length, 3); assert.match(r.errors[0], /"t" must be a number/); assert.deepEqual(r.values.map((v) => v.name), ["humidity"]);
  assert.equal(mapPayload(JSON.stringify({ id: { x: 1 }, t: 1 }), O).deviceId, null); assert.equal(mapPayload(JSON.stringify({ t: 1 }), O).status, "error");        // no / bad device id
});
test("Mapping: invalid JSON, non-objects and huge payloads never throw", () => {
  for (const bad of ["", "not json", "{", "[1,2]", "null", "42", '"s"', "\u0000\u0001", Buffer.from([0xff, 0xfe, 0x7b])]) { const r = mapPayload(bad as any, O); assert.equal(r.status, "error", String(bad)); assert.equal(r.values.length, 0); }
  assert.deepEqual(mapPayload("{", O).errors, ["invalid JSON"]); assert.match(mapPayload("x".repeat(70000), O).errors[0], /too large/);
  assert.equal(mapPayload(JSON.stringify({ id: "A", t: 1e308 }), { ...O, rules: [{ path: "t", name: "t", unit: "", scale: 1e308, offset: 0 }] }).status, "error", "overflow is an error, not Infinity in the database");
  assert.deepEqual(getPath({ a: { b: [5] } }, "a.b.0"), { found: true, value: 5 }); assert.equal(getPath({}, "constructor").found, false);
});
test("Mapping rules, topic filters and topic matching: validation", () => {
  assert.equal(checkRules(DEFAULT_RULES, "id", "ts"), null);
  for (const [rules, idp] of [[[{ ...DEFAULT_RULES[0], scale: 0 }], "id"], [[{ ...DEFAULT_RULES[0], name: "Bad Name" }], "id"], [[DEFAULT_RULES[0], DEFAULT_RULES[0]], "id"], [[{ ...DEFAULT_RULES[0], path: "id" }], "id"], [DEFAULT_RULES, "bad path"], ["x", "id"]] as const) assert.ok(checkRules(rules, idp, "ts"), JSON.stringify(rules).slice(0, 60));
  for (const ok of ["fp/+/data", "fp/#", "#", "a/b/c", "fp/+"]) assert.equal(checkFilter(ok), null, ok);
  for (const bad of ["", "  ", " a", "a b", "fp/#/x", "fp/a#", "fp/a+/b", "$SYS/#", "x".repeat(201), "a\u0000b", 5]) assert.ok(checkFilter(bad), String(bad));
  assert.ok(topicMatches("fp/+/data", "fp/x1/data") && !topicMatches("fp/+/data", "fp/x1/status") && !topicMatches("fp/+/data", "fp/x1/data/more") && topicMatches("fp/#", "fp/a/b/c") && topicMatches("#", "x"));
  assert.deepEqual([0, 1, 2, 3, 6, 9].map(backoffMs), [1000, 2000, 4000, 8000, 60000, 60000]);
});
test("The placeholder defaults live in ONE file and are what a fresh database holds", async () => {
  const x = await boot(); const v = await x.get();
  assert.deepEqual(v.topics.map((t: any) => [t.filter, t.qos]), DEFAULT_TOPICS.map((t) => [t.filter, t.qos])); assert.deepEqual(v.mapping.rules, DEFAULT_RULES);
  assert.equal(v.config.enabled, false); assert.equal(v.status.state, "disabled"); assert.equal(v.config.host, "mqtt.farm-pilot.com"); assert.equal(v.config.port, 8883);
  for (const f of ["mapping.ts", "service.ts"]) assert.ok(!/mqtt\.farm-pilot\.com|fp\/\+\/data/.test(readFileSync(`src/mqtt/${f}`, "utf8")), `${f} must not hard-code the placeholder format`);
});

// ---------------------------------------------------------------- password and roles
test("Password: encrypted at rest, never in any API response, audit row or database column in clear", async () => {
  const x = await boot(); const PW = "s3cret-Pa55-w0rd";
  const blob = encryptSecret(PW); assert.ok(!blob.includes(PW)); assert.equal(decryptSecret(blob), PW); { const [v, iv, tag, ct] = blob.split(":"); const b = Buffer.from(ct, "base64"); b[0] ^= 1; assert.equal(decryptSecret([v, iv, tag, b.toString("base64")].join(":")), null, "tampering is detected"); } assert.equal(decryptSecret("junk"), null);
  const put = await x.call(x.admin, "PUT", "/api/mqtt/config", { username: "u1", password: PW });
  assert.equal(put.status, 200); assert.equal(put.json.config.has_password, true);
  const responses = [put, await x.call(x.admin, "GET", "/api/mqtt"), await x.call(x.admin, "POST", "/api/mqtt/test", { host: "127.0.0.1", port: 1, tls: false }), await x.call(x.admin, "POST", "/api/mqtt/enabled", { enabled: false }), await x.call(x.admin, "GET", "/api/me")];
  for (const r of responses) { assert.ok(!r.txt.includes(PW), "the password appears in a response"); assert.ok(!/password"\s*:\s*"/.test(r.txt), "a password field with a value appears"); }
  const row = x.db.prepare("SELECT * FROM mqtt_config").get() as any; assert.ok(row.password_enc.startsWith("v1:") && !row.password_enc.includes(PW));
  assert.ok(!JSON.stringify(x.db.prepare("SELECT * FROM audit_log").all()).includes(PW), "the audit log never holds it");
  assert.equal((x.db.prepare("SELECT detail FROM audit_log WHERE action='mqtt.config'").get() as any).detail.includes('"password":"changed"'), true);
  const keep = await x.call(x.admin, "PUT", "/api/mqtt/config", { username: "u2" }); assert.equal(keep.json.config.has_password, true, "omitting the password keeps it");
  const gone = await x.call(x.admin, "PUT", "/api/mqtt/config", { password: "" }); assert.equal(gone.json.config.has_password, false, "empty password removes it");
});
test("Roles: an Operator can READ the page data (never the password); every write and the test are Admin only; anonymous gets 401", async () => {
  const x = await boot(); await x.call(x.admin, "PUT", "/api/mqtt/config", { password: "op-must-not-see" });
  const rd = await x.call(x.op, "GET", "/api/mqtt"); assert.equal(rd.status, 200); assert.ok(rd.json.topics.length && rd.json.mapping.rules.length && rd.json.config.host); assert.ok(!rd.txt.includes("op-must-not-see")); assert.equal(rd.json.config.has_password, true);
  const mqttRoutes = x.routes.filter((r) => r.url.startsWith("/api/mqtt") && r.method !== "HEAD"); assert.ok(mqttRoutes.length >= 9, `found ${mqttRoutes.length} MQTT routes`);
  for (const r of mqttRoutes) { const url = r.url.replace(/:id/g, "1"); const body = r.method === "GET" || r.method === "DELETE" ? undefined : {}; const isRead = r.method === "GET";
    const o = await x.call(x.op, r.method, url, body); assert.equal(o.status, isRead ? 200 : 403, `${r.method} ${r.url} Operator`);
    assert.equal((await x.call(null, r.method, url, body)).status, 401, `${r.method} ${r.url} anonymous`); }
  assert.equal((await x.get()).topics.length, 2, "nothing was changed by the Operator attempts");
});
// ---------------------------------------------------------------- topics
test("Topics: add and remove with validation, duplicates refused, counts start at 0", async () => {
  const x = await boot(); const post = (filter: any, qos: any = 1) => x.call(x.admin, "POST", "/api/mqtt/topics", { filter, qos });
  assert.equal((await post("farm/+/temp", 2)).status, 200); const v = await x.get(); assert.equal(v.topics.length, 3); assert.equal(v.topics[2].count, 0);
  assert.equal((await post("farm/+/temp")).status, 409);
  for (const bad of ["", "a b", "fp/#/x", "$SYS/#", "x+y"]) assert.equal((await post(bad)).status, 400, bad);
  for (const bad of [3, "1", null, -1]) assert.equal((await post("ok/topic", bad)).status, 400, "qos " + bad);
  const id = v.topics[2].id; assert.equal((await x.call(x.admin, "DELETE", "/api/mqtt/topics/" + id)).status, 200); assert.equal((await x.get()).topics.length, 2);
  assert.equal((await x.call(x.admin, "DELETE", "/api/mqtt/topics/" + id)).status, 404); assert.equal((await x.call(x.admin, "DELETE", "/api/mqtt/topics/abc")).status, 400);
});
test("Connection settings are validated", async () => {
  const x = await boot(); const put = (b: any) => x.call(x.admin, "PUT", "/api/mqtt/config", b);
  for (const b of [{ host: "" }, { host: "bad host" }, { port: 0 }, { port: 70000 }, { port: "1883" }, { tls: "yes" }, { keepalive: 1 }, { client_id: "has space" }, { password: 5 }]) assert.equal((await put(b)).status, 400, JSON.stringify(b));
  assert.equal((await put({ host: "broker.example.org", port: 1883, tls: false, keepalive: 60, client_id: "core-x", username: "me" })).status, 200);
});

// ---------------------------------------------------------------- live: states, ingest, devices, reconnect
test("Connect, receive, new-device flow (add and ignore), bad JSON, disconnect and reconnect with backoff, against a real broker", async () => {
  const b = await broker(); const x = await boot({ backoff: () => 150 });
  assert.equal((await x.call(x.admin, "PUT", "/api/mqtt/config", local(b.port))).status, 200); await x.mq.start();
  assert.equal((await x.get()).status.state, "disabled", "starts DISABLED, never connects by itself");
  const en = await x.call(x.admin, "POST", "/api/mqtt/enabled", { enabled: true }); assert.equal(en.status, 200);
  await until(async () => (await x.get()).status.state === "connected", "CONNECTED"); assert.match((await x.get()).config.client_id, /^core-[0-9a-f]{8}$/, "an automatic client id is kept");
  // new device: seen, listed, NOT stored yet
  await publish(b.port, "fp/dev1/data", JSON.stringify({ id: "dev1", ts: 1790000000, t: 21.5, h: 55, zzz: 9 }));
  await publish(b.port, "fp/dev2/data", JSON.stringify({ id: "dev2", t: 30 }));
  await until(async () => (await x.get()).devices.length === 2, "two new devices");
  let v = await x.get(); assert.deepEqual(v.devices.map((d: any) => [d.device_id, d.state]), [["dev1", "new"], ["dev2", "new"]]); assert.equal(x.db.prepare("SELECT COUNT(*) c FROM series WHERE topic=?").get(SERIES_TOPIC).c, 0);
  assert.equal(v.topics.find((t: any) => t.filter === "fp/+/data").count, 2); assert.equal(v.status.perMinute, 2); assert.ok(v.status.lastMessageAt);
  assert.deepEqual(v.mapping.unmapped, [{ field: "zzz", count: 1 }]);
  // ADD: values stored under mqtt/payload; IGNORE: dropped
  assert.equal((await x.call(x.admin, "POST", "/api/mqtt/devices/dev1/add", { label: "Row 1" })).status, 200); assert.equal((await x.call(x.admin, "POST", "/api/mqtt/devices/dev2/ignore")).status, 200);
  assert.equal((await x.call(x.admin, "POST", "/api/mqtt/devices/nope/add", {})).status, 404); assert.equal((await x.call(x.admin, "POST", "/api/mqtt/devices/bad id!/add", {})).status, 400);
  await publish(b.port, "fp/dev1/data", JSON.stringify({ id: "dev1", ts: 1790000000, t: 22.25, h: 56 })); await publish(b.port, "fp/dev2/data", JSON.stringify({ id: "dev2", t: 31 }));
  await until(() => x.db.prepare("SELECT COUNT(*) c FROM latest l JOIN series s ON s.id=l.series_id WHERE s.topic=? AND s.sensor_key='dev1'").get(SERIES_TOPIC).c === 2, "dev1 values stored");
  const t = x.db.prepare("SELECT l.value,l.ts FROM latest l JOIN series s ON s.id=l.series_id WHERE s.topic=? AND s.sensor_key='dev1' AND s.metric='temperature'").get(SERIES_TOPIC) as any; assert.equal(t.value, 22.25); assert.equal(t.ts, 1790000000 * 1000, "the payload timestamp is used");
  assert.equal(x.db.prepare("SELECT COUNT(*) c FROM series WHERE sensor_key='dev2'").get().c, 0, "an ignored device is never stored");
  assert.equal((await x.call(x.op, "GET", "/api/state")).status, 200); assert.ok(!(await x.call(x.admin, "GET", "/api/state")).txt.includes("mqtt/payload"), "/api/state never lists the MQTT series");
  // bad payloads: counted, shown, nothing crashes
  const before = (await x.get()).mapping.errors; await publish(b.port, "fp/dev1/data", "{not json"); await publish(b.port, "fp/dev1/data", JSON.stringify({ id: "dev1", t: "warm" })); await publish(b.port, "fp/x/data", "[1]");
  await until(async () => (await x.get()).mapping.errors === before + 3, "3 errors counted"); v = await x.get();
  assert.deepEqual(v.messages.slice(0, 3).map((m: any) => m.status), ["error", "error", "error"]); assert.equal(v.messages[0].payload, "[1]", "newest first, raw text kept"); assert.equal(v.status.state, "connected");
  assert.ok(v.messages.length <= 20); assert.equal((await x.call(x.admin, "POST", "/api/mqtt/enabled", { enabled: "yes" })).status, 400);
  // broker goes away: DISCONNECTED with a plain reason, CORE keeps answering, then it comes back by itself
  await b.stop(); await until(async () => (await x.get()).status.state !== "connected", "DISCONNECTED/CONNECTING after the broker stopped");
  assert.equal((await x.call(x.admin, "GET", "/api/mqtt")).status, 200); assert.equal((await x.call(x.op, "GET", "/api/me")).status, 200, "the rest of CORE is not blocked");
  await until(async () => { const s = (await x.get()).status; return s.state === "disconnected" || s.state === "connecting"; }, "retrying"); await until(async () => !!(await x.get()).status.lastError, "an error sentence"); assert.match((await x.get()).status.lastError, /refused|closed|reach|No answer|problem/i);
  await b.restart(); await until(async () => (await x.get()).status.state === "connected", "CONNECTED again after the broker restart", 15000);
  await publish(b.port, "fp/dev1/data", JSON.stringify({ id: "dev1", t: 23 })); await until(async () => (await x.get()).devices.find((d: any) => d.device_id === "dev1").msg_count >= 3, "device counters flushed");
  // disable: DISABLED lamp, connection closed
  await x.call(x.admin, "POST", "/api/mqtt/enabled", { enabled: false }); v = await x.get(); assert.equal(v.status.state, "disabled"); assert.equal(v.status.lastError, null);
  assert.equal((await x.call(x.admin, "GET", "/api/mqtt")).json.config.enabled, false);
});

// ---------------------------------------------------------------- TEST CONNECTION
test("TEST CONNECTION: success and failure messages; a test never enables the source", async () => {
  const b = await broker(); const x = await boot();
  const ok = await x.call(x.admin, "POST", "/api/mqtt/test", local(b.port)); assert.equal(ok.status, 200); assert.equal(ok.json.ok, true); assert.match(ok.json.message, new RegExp(`Connected to 127\\.0\\.0\\.1:${b.port}`));
  await b.stop(); const refused = await x.call(x.admin, "POST", "/api/mqtt/test", local(b.port)); assert.equal(refused.json.ok, false); assert.match(refused.json.message, /Connection refused: nothing is listening on 127\.0\.0\.1:/);
  const bad = await x.call(x.admin, "POST", "/api/mqtt/test", { host: "bad host", port: 1883 }); assert.equal(bad.json.ok, false); assert.match(bad.json.message, /host/); assert.equal((await x.get()).status.state, "disabled", "a test never enables the source");
  const nohost = await x.call(x.admin, "POST", "/api/mqtt/test", { host: "no-such-host.invalid", port: 1883, tls: false }); assert.equal(nohost.json.ok, false); assert.match(nohost.json.message, /not found|cannot be reached|problem|No answer/i);
});

// ---------------------------------------------------------------- menu
test("Menu: DATA SOURCES (renamed) holds RS-485 Ports, Sensors Gateway, MQTT Payload, Sensors in that order, on the desktop sidebar and the phone MORE sheet; no DATA POINTS left", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8");
  assert.match(sb, /title: "Data sources", tabs: \[\["rs485-ports", "RS-485 PORTS"\], \["sensors-gateway", "SENSORS GATEWAY"\], \["mqtt-payload", "MQTT PAYLOAD"\], \["sensors", "SENSORS"\]\]/);
  assert.match(sb, /text-transform|GROUPS/); assert.match(ab, /GROUPS\.filter/, "the MORE sheet is built from the same GROUPS"); assert.match(ab, /SETTINGS, DATA SOURCES, SYSTEM/);
  assert.match(st, /t === "mqtt-payload" \? <MqttPayloadPage readOnly=\{!admin\} \/>/, "the route #/settings/mqtt-payload opens the page");
  for (const f of ["web/src/Sidebar.tsx", "web/src/About.tsx", "web/src/Settings.tsx", "web/src/core.css", "README.md", "CHANGELOG.md"]) assert.ok(!/data points/i.test(readFileSync(f, "utf8")), `${f} still says DATA POINTS`);
  const css = readFileSync("web/src/core.css", "utf8"); assert.match(css, /\.fp-sb-brand img \{ width: 104px; height: 104px; border-radius: 50%/, "round logo 104 px"); assert.match(css, /\.fp-sb-brand \{ display: flex; flex-direction: column; align-items: center; text-align: center/, "logo and farm name centred, name directly under the logo");
  assert.match(css, /\.fp-sb-brand span \{ font-size: 20px; font-weight: 700/, "farm name bold");
});
test("Operator UI: MQTT PAYLOAD is reachable read-only (plain item, no group heading; phone MORE row); the other Settings stay Admin only", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8"), p = readFileSync("web/src/MqttPayloadPage.tsx", "utf8");
  assert.match(sb, /\{!admin && <button[^\n]*go\("\/settings\/mqtt-payload"\)[^\n]*>MQTT PAYLOAD<\/button>\}/); assert.match(ab, /\{!admin && row\("mqtt-payload", "MQTT PAYLOAD", "\/settings\/mqtt-payload"\)\}/);
  assert.match(app, /me\.role !== "admin" && page === "settings" && rest\[0\] !== "mqtt-payload"\) go\("\/monitoring"\)/); assert.match(st, /<MqttPayloadPage readOnly=\{!admin\} \/>/);
  assert.match(p, /<fieldset className="mq"[^>]*disabled=\{readOnly\}/); assert.match(readFileSync("web/src/mqtt.css", "utf8"), /\.mq\[data-ro\] \.fp-btn:not\(\.fp-seg \.fp-btn\)[^}]*display: none/);
});
test("Page: card order, lamp shapes with words, 44 px / 56 px targets, Rajdhani + JetBrains Mono via tokens, no colour-only status", () => {
  const p = readFileSync("web/src/MqttPayloadPage.tsx", "utf8"), css = readFileSync("web/src/mqtt.css", "utf8");
  const order = ["Connection status", "aria-label=\"Connection\"", "Subscriptions", "New devices found", "Payload mapping", "Latest messages"].map((k) => p.indexOf(k)); assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "banner, CONNECTION, SUBSCRIPTIONS, NEW DEVICES FOUND, PAYLOAD MAPPING, LATEST MESSAGES");
  for (const w of ["CONNECTED", "CONNECTING", "DISCONNECTED", "DISABLED", "TEST CONNECTION", "SAVE", "ENABLE", "ADD AS SENSOR", "IGNORE", "LATEST MESSAGES"]) assert.ok(p.includes(w), w);
  for (const s of ["circle", "triangle", "square", "ring"]) assert.ok(css.includes(`data-shape="${s}"`), s);
  assert.ok(/type="password"/.test(p) && /username: x\.config\.username, password: ""/.test(p) && /placeholder=\{v\.config\.has_password/.test(p), "the password field is always reset to empty, never pre-filled");
  assert.ok(/min-height: 44px/.test(css) && /\.fp-btn\.primary \{ min-height: 56px/.test(readFileSync("web/src/core.css", "utf8")), "44 px targets, 56 px primary");
});
