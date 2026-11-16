import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// Licence model (Step 2 + 3): file format, signature, device binding, install/remove over HTTP with audit, FREE defaults, limits only block ADDING, nothing else is touched.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey, type KeyObject } from "node:crypto"; import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDb } from "../src/db.js"; import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { Registry } from "../src/gateway/registry.js";
import { canonicalJson, checkLicence, parseLicenceFile, signLicence, LicenceError, MAX_LICENCE_BYTES, type LicencePayload } from "../src/licence/format.js";
import { LicenceService } from "../src/licence/service.js"; import { multipartFile } from "../src/licence/multipart.js"; import { FREE_LICENCE } from "../src/licence/free.js"; import { usage } from "../src/licence/usage.js";
import { rig } from "./rig.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" };
const closers: (() => unknown)[] = []; after(() => Promise.all(closers.map((c) => c())));
const DEV = "FP-AAAA-BBBB-CCCC", KEY = generateKeyPairSync("ed25519"), OTHER = generateKeyPairSync("ed25519");
const pub = (k: { publicKey: KeyObject }) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64"); const KEYS = { "t-1": pub(KEY) };
const NOW = Date.parse("2026-11-16T12:00:00Z");
const payload = (o: Partial<LicencePayload> = {}): LicencePayload => ({ licence_id: "FPL-20261116-0001", type: "FULL", licensed_to: "Al Maimoon Farms", device_id: DEV, limits: { gateways: 2, sensors: 50 }, features: [], issued_at: "2026-11-16T10:00:00Z", valid_until: null, key_id: "t-1", ...o });
const issue = (o: Partial<LicencePayload> = {}, key = KEY.privateKey) => Buffer.from(signLicence(payload(o), key));
function mkService(db = openDb(":memory:"), dir = mkdtempSync(join(tmpdir(), "fp-lic-")), clock = { t: NOW }) { return { db, dir, clock, lic: new LicenceService(db, { dataDir: dir, keys: KEYS, deviceId: () => DEV, now: () => clock.t }) }; }
const codeOf = (f: () => unknown) => { try { f(); } catch (e: any) { return e.code ?? e.extra?.code ?? e.message; } return "no error"; };
const audits = (db: any, action: string) => db.prepare("SELECT detail FROM audit_log WHERE action=?").all(action).map((r: any) => JSON.parse(r.detail));
const addSensors = (db: any, n: number, type = "th", from = 1) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at) VALUES(?,?,?,5,1)").run(String(112600000 + from + i), type, from + i); };
const multipart = (name: string, content: Buffer, extra = "") => { const b = "----fpTest" + Math.random().toString(16).slice(2); return { ct: `multipart/form-data; boundary=${b}`, body: Buffer.concat([Buffer.from(`--${b}\r\n${extra}Content-Disposition: form-data; name="${name}"; filename="x.fplic"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${b}--\r\n`)]) }; };

test("format is frozen: canonical JSON sorts keys at every level; a fixed key signs a fixed licence to a fixed signature (Ed25519 is deterministic)", () => {
  assert.equal(canonicalJson({ b: [3, { z: 1, a: "x" }], a: null }), '{"a":null,"b":[3,{"a":"x","z":1}]}');
  const seed = Buffer.alloc(32, 7), der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]); const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const f = JSON.parse(signLicence(payload(), priv)); assert.equal(f.signature, "xPRjI1GIH8evOsw2NYwbLunWgCdS1oP5oO1XKWdVJErixCFXq1vQfnPxvscmkNt3H7VsxhMQrPi2QB681Dc0Bw", "format changed: the licence format is frozen, bump the version instead");
});
test("shape: empty, too large, not JSON, array, unknown field, missing field, type FREE, bad limits, bad dates are all NOT_A_LICENCE", () => {
  const ok = JSON.parse(issue().toString()); const mut = (f: (j: any) => void) => { const j = structuredClone(ok); f(j); return Buffer.from(JSON.stringify(j)); };
  assert.ok(parseLicenceFile(issue())); const bad: [string, Buffer][] = [["empty", Buffer.alloc(0)], ["large", Buffer.alloc(MAX_LICENCE_BYTES + 1, 32)], ["text", Buffer.from("hello")], ["array", Buffer.from("[]")],
    ["unknown", mut((j) => (j.extra = 1))], ["missing", mut((j) => delete j.features)], ["free", mut((j) => (j.type = "FREE"))], ["neg", mut((j) => (j.limits.sensors = -1))], ["float", mut((j) => (j.limits.gateways = 1.5))], ["limits keys", mut((j) => (j.limits.pumps = 1))],
    ["date", mut((j) => (j.issued_at = "yesterday"))], ["valid_until", mut((j) => (j.valid_until = "2027-01-01"))], ["id", mut((j) => (j.licence_id = "X1"))], ["device", mut((j) => (j.device_id = "FP-1234"))], ["sig", mut((j) => (j.signature = "abc"))], ["features", mut((j) => (j.features = [1]))]];
  for (const [n, b] of bad) assert.equal(codeOf(() => parseLicenceFile(b)), "NOT_A_LICENCE", n);
});
test("signature and device: tampering any field gives BAD_SIGNATURE, unknown key id BAD_SIGNATURE, another box WRONG_DEVICE, a good file passes", () => {
  assert.equal(checkLicence(issue(), KEYS, DEV).licence_id, "FPL-20261116-0001");
  const j = JSON.parse(issue().toString());
  for (const [k, v] of [["licensed_to", "Someone Else"], ["limits", { gateways: 2, sensors: 5000 }], ["valid_until", "2099-01-01T00:00:00Z"], ["type", "ENTERPRISE"], ["device_id", "FP-1111-2222-3333"], ["features", ["x"]], ["licence_id", "FPL-20261116-0009"], ["issued_at", "2026-11-16T10:00:01Z"]] as const)
    assert.equal(codeOf(() => checkLicence(Buffer.from(JSON.stringify({ ...j, [k]: v })), KEYS, k === "device_id" ? "FP-1111-2222-3333" : DEV)), "BAD_SIGNATURE", `tampered ${k}`);
  assert.equal(codeOf(() => checkLicence(issue({}, OTHER.privateKey), KEYS, DEV)), "BAD_SIGNATURE", "signed with a different key");
  assert.equal(codeOf(() => checkLicence(issue({ key_id: "nope" }), KEYS, DEV)), "BAD_SIGNATURE", "unknown key id"); assert.equal(codeOf(() => checkLicence(issue({ key_id: "constructor" }), KEYS, DEV)), "BAD_SIGNATURE");
  assert.equal(codeOf(() => checkLicence(issue(), KEYS, "FP-DDDD-EEEE-FFFF")), "WRONG_DEVICE"); assert.equal(codeOf(() => checkLicence(issue(), KEYS, null)), "WRONG_DEVICE");
  assert.equal(codeOf(() => checkLicence(issue({}, KEY.privateKey), { "t-1": pub(OTHER) }, DEV)), "BAD_SIGNATURE", "rotation: a box that only holds another key refuses");
});
test("multipart reader: finds the named field among others, keeps binary bytes, refuses a missing field", () => {
  const f = Buffer.from([0, 255, 13, 10, 45, 45, 1, 2, 3]); const m = multipart("file", f, 'Content-Disposition: form-data; name="note"\r\n\r\nhello\r\n--zz\r\n'.slice(0, 0));
  assert.deepEqual(multipartFile(m.ct, m.body), f); assert.equal(multipartFile(m.ct, m.body, "other"), null); assert.equal(multipartFile("multipart/form-data", m.body), null); assert.equal(multipartFile(m.ct, Buffer.from("garbage")), null);
});

test("FREE defaults: no licence = 1 gateway and 10 sensors in total; the 10th is accepted, the 11th refused with the message that names the limit and the About page", () => {
  const { db, lic } = mkService(); const reg = new Registry(db, map); reg.limiter = lic; const s = lic.summary();
  assert.deepEqual(s.limits, { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors }); assert.equal(FREE_LICENCE.gateways, 1); assert.equal(FREE_LICENCE.sensors, 10); assert.equal(s.state, "FREE"); assert.equal(s.type, "FREE");
  reg.add(A, "th", ["112600101", "112600102", "112600103", "112600104", "112600105", "112600106", "112600107", "112600108", "112600109"]); reg.add(A, "th", ["112600110"]);                // 9 then the 10th
  assert.equal(usage(db).sensors, 10);
  try { reg.add(A, "th", ["112600111"]); assert.fail("11th must be refused"); } catch (e: any) { assert.equal(e.status, 409); assert.equal(e.message, "Free licence allows 10 sensors in total. Upload a licence on the About page."); assert.equal(e.extra.code, "LICENCE_LIMIT"); }
  assert.equal(usage(db).sensors, 10, "the refused add changed nothing"); assert.equal(codeOf(() => reg.add(A, "th", ["112600111", "112600112"])), "LICENCE_LIMIT", "a pasted list that would pass 10 is refused as a whole"); assert.equal(usage(db).sensors, 10);
});
test("sensors of ALL types count together; replaced sensors do not; pumps and weather station do not", () => {
  const { db, lic } = mkService(); addSensors(db, 6, "th", 1); addSensors(db, 3, "soil", 7); addSensors(db, 1, "light", 20); db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at,replaced_by) VALUES('999999999','th',NULL,5,1,'112600001')").run();
  assert.equal(usage(db).sensors, 10, "6 T/H + 3 soil + 1 light; the replaced row is history"); assert.equal(codeOf(() => lic.checkSensorsAdd(1)), "LICENCE_LIMIT"); lic.checkSensorsAdd(0);
  db.exec("CREATE TABLE IF NOT EXISTS bus_devices (id INTEGER PRIMARY KEY, kind TEXT, enabled INTEGER)"); db.exec("INSERT INTO bus_devices(kind,enabled) VALUES('lora_gateway',1),('weather',1)"); assert.equal(usage(db).gateways, 1, "the weather station is not a gateway");
  assert.equal(codeOf(() => lic.checkGatewayAdd(1)), "LICENCE_LIMIT"); assert.match((() => { try { lic.checkGatewayAdd(1); } catch (e: any) { return e.message; } return ""; })(), /^Free licence allows 1 gateway in total\./);
});
test("over-limit box (older install): everything stays, ADD is refused, the summary says over_limit; restore and Send cannot be used to add", () => {
  const { db, lic } = mkService(); addSensors(db, 12); const reg = new Registry(db, map); reg.limiter = lic;
  const s = lic.summary(); assert.equal(s.over_limit, true); assert.equal(s.usage.sensors, 12); assert.equal(reg.list().length, 12, "nothing was removed"); assert.equal(codeOf(() => reg.add(A, "th", ["112600500"])), "LICENCE_LIMIT");
  reg.remove(A, "112600001"); reg.update(A, "112600002", { label: "still editable" }); assert.equal(reg.list().length, 11, "removing, editing and replacing are never blocked"); assert.equal(codeOf(() => reg.add(A, "th", ["112600500"])), "LICENCE_LIMIT", "still over: 11 of 10");
  lic.checkSend(11, 0); assert.equal(codeOf(() => lic.checkSend(11, 1)), "LICENCE_LIMIT", "SEND TO GATEWAY with unsent sensors while above the limit"); lic.checkSend(8, 3);
  lic.checkSensorsTotal(11); lic.checkSensorsTotal(5); assert.equal(codeOf(() => lic.checkSensorsTotal(12)), "LICENCE_LIMIT", "a restore with MORE sensors than the box has, above the limit, is refused");
  const dev = reg.exportAll(); assert.equal(codeOf(() => reg.restore(A, { ...dev, sensors: [...dev.sensors, ...Array.from({ length: 5 }, (_, i) => ({ serial: String(112600600 + i), type: "th", label: "", zone_id: null, slot: 20 + i, reporting_interval: 5, created_at: 1, replaced_by: null, thresholds: null }))] })), "LICENCE_LIMIT");
  reg.restore(A, dev);                                                                                                                                                                  // restoring what it already has is fine
});

test("HTTP install: multipart upload applies the licence and lifts the limits; file and table row are stored; audit entry; the 11th sensor now works; restart keeps it", async () => {
  const { db, dir, lic } = mkService(); const x = await rig({ db, lic }); closers.push(x.close); const reg = new Registry(db, map); reg.limiter = lic; addSensors(db, 10);
  assert.equal(codeOf(() => reg.add(A, "th", ["112600900"])), "LICENCE_LIMIT");
  const m = multipart("file", issue()); const r = await x.call(x.admin, "POST", "/api/licence", m.body, { "content-type": m.ct }); assert.equal(r.status, 200, r.txt);
  assert.equal(r.json.state, "LICENSED"); assert.equal(r.json.type, "FULL"); assert.equal(r.json.licensed_to, "Al Maimoon Farms"); assert.deepEqual(r.json.limits, { gateways: 2, sensors: 50 });
  reg.add(A, "th", ["112600900"]); assert.equal(usage(db).sensors, 11, "the 11th sensor is accepted under the new licence");
  assert.equal(readFileSync(join(dir, "licence", "current.fplic"), "utf8"), issue().toString(), "file stored byte for byte"); if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(join(dir, "licence", "current.fplic")).mode & 0o077, 0, "owner only");
  const row = db.prepare("SELECT * FROM licence").get() as any; assert.deepEqual([row.licence_id, row.type, row.licensed_to, row.installed_by, row.valid_until], ["FPL-20261116-0001", "FULL", "Al Maimoon Farms", "admin", null]); assert.deepEqual(JSON.parse(row.limits_json), { gateways: 2, sensors: 50 }); assert.match(row.file_sha256, /^[0-9a-f]{64}$/);
  const au = audits(db, "licence.install"); assert.equal(au.length, 1); assert.equal(au[0].licence_id, "FPL-20261116-0001");
  const about = (await x.call(x.admin, "GET", "/api/about")).json; assert.equal(about.licence.state, "LICENSED"); assert.equal(about.licence.usage.sensors, 11);
  assert.equal(new LicenceService(db, { dataDir: dir, keys: KEYS, deviceId: () => DEV, now: () => NOW }).summary().state, "LICENSED", "a restart re-reads and re-verifies the stored file");
  const raw = await x.call(x.admin, "POST", "/api/licence", issue({ licence_id: "FPL-20261116-0002", limits: { gateways: 3, sensors: 99 } }), { "content-type": "application/octet-stream" }); assert.equal(raw.status, 200, "plain file body (curl) works too"); assert.equal(raw.json.limits.sensors, 99);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM licence").get()!.c, 1, "one box, one licence");
});
test("HTTP refusals: each reason has its code, plain-language text, no change to the box, and an audit entry; every refusal leaves the previous licence active", async () => {
  const { db, lic, clock } = mkService(); const x = await rig({ db, lic }); closers.push(x.close); const up = (b: Buffer) => { const m = multipart("file", b); return x.call(x.admin, "POST", "/api/licence", m.body, { "content-type": m.ct }); };
  assert.equal((await up(issue())).status, 200);
  const cases: [string, Buffer, string, RegExp][] = [["NOT_A_LICENCE", Buffer.from("not a licence"), "NOT_A_LICENCE", /not a Farm-Pilot CORE licence/], ["BAD_SIGNATURE", Buffer.from(JSON.stringify({ ...JSON.parse(issue({ licence_id: "FPL-20261116-0005" }).toString()), licensed_to: "Hacker" })), "BAD_SIGNATURE", /damaged|changed/],
    ["WRONG_DEVICE", issue({ licence_id: "FPL-20261116-0005", device_id: "FP-1111-2222-3333" }), "WRONG_DEVICE", /another box/], ["EXPIRED", issue({ licence_id: "FPL-20261116-0005", valid_until: "2026-11-01T00:00:00Z" }), "EXPIRED", /expired on 2026-11-01/], ["OLDER_LICENCE", issue({ licence_id: "FPL-20261101-0001", limits: { gateways: 9, sensors: 999 } }), "OLDER_LICENCE", /older than the one installed/],
    ["too large", Buffer.alloc(20 * 1024, 32), "NOT_A_LICENCE", /larger than 16 KB/]];
  for (const [n, b, code, re] of cases) { const r = await up(b); assert.equal(r.status, 400, n); assert.equal(r.json.code, code, n); assert.match(r.json.error, re, n); }
  const refused = audits(db, "licence.refused"); assert.deepEqual(refused.map((a: any) => a.code), ["NOT_A_LICENCE", "BAD_SIGNATURE", "WRONG_DEVICE", "EXPIRED", "OLDER_LICENCE", "NOT_A_LICENCE"]); for (const a of refused) assert.match(a.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(lic.summary().limits.sensors, 50, "the installed licence is untouched by every refusal"); assert.equal((await x.call(x.admin, "POST", "/api/licence", Buffer.alloc(0), { "content-type": "application/octet-stream" })).json.code, "NOT_A_LICENCE");
  const m = multipart("wrongfield", issue()); assert.equal((await x.call(x.admin, "POST", "/api/licence", m.body, { "content-type": m.ct })).json.code, "NOT_A_LICENCE", "no file field"); void clock;
  assert.equal((await up(issue({ licence_id: "FPL-20261116-0001" }))).status, 200, "the same licence id again is not 'older'"); assert.equal((await up(issue({ licence_id: "FPL-20270101-0001" }))).status, 200, "a newer one is");
});
test("Operator: POST and DELETE /api/licence are 403 (nothing written, nothing audited); About shows the summary but no Device ID", async () => {
  const { db, lic } = mkService(); const x = await rig({ db, lic }); closers.push(x.close); const m = multipart("file", issue());
  assert.equal((await x.call(x.op, "POST", "/api/licence", m.body, { "content-type": m.ct })).status, 403); assert.equal((await x.call(x.op, "DELETE", "/api/licence")).status, 403); assert.equal((await x.call(null, "POST", "/api/licence", m.body, { "content-type": m.ct })).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM licence").get()!.c, 0); assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'licence.%'").get()!.c, 0);
  const o = await x.call(x.op, "GET", "/api/about"); assert.equal(o.status, 200); assert.equal(o.json.licence.state, "FREE"); assert.ok(!("device_id" in o.json) && !("computer" in o.json)); assert.ok(!o.txt.includes(DEV));
});
test("remove returns to FREE (audited, file and row gone, 404 when there is nothing); expiry, tampering and a missing file fall back to FREE limits without stopping anything", async () => {
  const { db, dir, lic, clock } = mkService(); const x = await rig({ db, lic }); closers.push(x.close); addSensors(db, 20);
  lic.install(A, issue({ valid_until: "2026-12-01T00:00:00Z" })); assert.equal(lic.summary().state, "LICENSED"); assert.equal(lic.summary().over_limit, false);
  clock.t = Date.parse("2026-12-01T00:00:01Z"); const ex = lic.summary(); assert.equal(ex.state, "EXPIRED"); assert.equal(ex.type, "FULL"); assert.equal(ex.valid_until, "2026-12-01T00:00:00Z"); assert.deepEqual(ex.limits, { gateways: 1, sensors: 10 }); assert.equal(ex.over_limit, true, "20 sensors on FREE limits: OVER LIMIT");
  lic.refresh(); lic.refresh(); assert.equal(audits(db, "licence.expired").length, 1, "the change to EXPIRED is audited once");
  const cmd = await x.call(x.op, "POST", "/api/commands", { pump: "pump1", action: "on" }); assert.equal(cmd.status, 200, "pump commands keep working while the licence is expired and the box is over the limit"); assert.equal(usage(db).sensors, 20);
  clock.t = NOW; assert.equal(lic.summary().state, "LICENSED");
  writeFileSync(join(dir, "licence", "current.fplic"), readFileSync(join(dir, "licence", "current.fplic"), "utf8").replace("Al Maimoon", "Al Maimoom")); lic.refresh(); const inv = lic.summary(); assert.equal(inv.state, "INVALID"); assert.deepEqual(inv.limits, { gateways: 1, sensors: 10 }); assert.ok(inv.reason);
  assert.equal(audits(db, "licence.invalid").length, 1); assert.equal((await x.call(x.op, "POST", "/api/commands", { pump: "pump1", action: "off" })).status, 200);
  const rm = await x.call(x.admin, "DELETE", "/api/licence"); assert.equal(rm.status, 200); assert.equal(rm.json.state, "FREE"); assert.ok(!existsSync(join(dir, "licence", "current.fplic"))); assert.equal(db.prepare("SELECT COUNT(*) c FROM licence").get()!.c, 0); assert.equal(audits(db, "licence.remove").length, 1);
  assert.equal((await x.call(x.admin, "DELETE", "/api/licence")).status, 404);
  lic.install(A, issue()); db.prepare("DELETE FROM licence").run(); lic.refresh(); assert.equal(lic.summary().state, "INVALID", "file without a record is not trusted"); lic.remove(A); assert.equal(lic.summary().state, "FREE");
  lic.install(A, issue()); (await import("node:fs")).rmSync(join(dir, "licence", "current.fplic")); lic.refresh(); assert.equal(lic.summary().state, "INVALID", "record without a file"); assert.match(lic.summary().reason!, /missing/);
});
test("a licence for another box that is already on disk is INVALID at start (clone protection), FREE limits, existing sensors untouched", () => {
  const a = mkService(); a.lic.install(A, issue()); const other = new LicenceService(a.db, { dataDir: a.dir, keys: KEYS, deviceId: () => "FP-9999-9999-9999", now: () => NOW });
  assert.equal(other.summary().state, "INVALID"); assert.match(other.summary().reason!, /another box/); assert.equal(other.summary().limits.sensors, 10);
});
