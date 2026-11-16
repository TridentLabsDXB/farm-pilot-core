// 2026-11-17 -- licence v2 (null = unlimited, reports_days, retention_days), the ENGINEERING type, retention driven by the licence, dev-1 only in non-release builds,
// and the batch issuing tool. v1 files keep verifying (test/licence.test.ts pins the v1 signature).
import { test, after } from "node:test"; import assert from "node:assert/strict"; import { spawnSync } from "node:child_process"; import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js"; import { config } from "../src/config.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";
import { checkLicence, LicenceError, parseLicenceFile, signLicence, type LicencePayload } from "../src/licence/format.js"; import { LicenceService } from "../src/licence/service.js"; import { FREE_LICENCE } from "../src/licence/free.js";
import { PROD_KEYS, DEV_KEYS, trustedKeys, LICENCE_PUBLIC_KEYS } from "../src/licence/keys.js"; import { runRetention } from "../src/retention.js";
import { limitWord, licWord, atOrOver, wouldExceed, isEngineering } from "../web/src/licence.js";

const DEV = "FP-AAAA-BBBB-CCCC", KEY = generateKeyPairSync("ed25519"), KEYS = { "t-1": (KEY.publicKey as KeyObject).export({ type: "spki", format: "der" }).toString("base64") };
const base = (o: Partial<LicencePayload> = {}): LicencePayload => ({ format_version: 2, licence_id: "FPL-20261117-0001", type: "PRO", licensed_to: "V2 Farm", device_id: DEV, limits: { gateways: 2, sensors: 50, reports_days: 365, retention_days: 365 }, features: [], issued_at: "2026-11-17T10:00:00Z", valid_until: null, key_id: "t-1", ...o });
const eng = (o: Partial<LicencePayload> = {}) => base({ type: "ENGINEERING", limits: { gateways: null, sensors: null, reports_days: null, retention_days: null }, valid_until: null, ...o });
const file = (p: LicencePayload) => Buffer.from(signLicence(p, KEY.privateKey)); const code = (f: () => unknown) => { try { f(); } catch (e: any) { return e.code ?? e.message; } return "no error"; };
const v1p = (o: Partial<LicencePayload> = {}): LicencePayload => { const p: any = { ...base(o), limits: { gateways: 2, sensors: 50 } }; delete p.format_version; return p; };     // a v1 payload has no format_version key at all
const A = { username: "admin", role: "admin" };
const svc = (db = openDb(":memory:")) => ({ db, lic: new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-v2-")), keys: KEYS, deviceId: () => DEV, now: () => Date.parse("2026-11-17T12:00:00Z") }) });

test("format 2: null limits are valid, ranges are enforced, v1 files still verify, a v1 file cannot carry null, the signature covers format_version and every limit", () => {
  const ok = file(eng()); assert.equal(parseLicenceFile(ok).format_version, 2); assert.equal(checkLicence(ok, KEYS, DEV).type, "ENGINEERING");
  assert.equal(parseLicenceFile(file(base({ limits: { gateways: null, sensors: null, reports_days: null, retention_days: null } }))).limits.sensors, null, "a PRO file may be unlimited too");
  const v1 = Buffer.from(signLicence(v1p(), KEY.privateKey)); assert.equal(checkLicence(v1, KEYS, DEV).limits.sensors, 50, "v1 unchanged");
  const raw = (f: (j: any) => void, v2 = true) => { const j = JSON.parse((v2 ? file(base()) : v1).toString()); f(j); return Buffer.from(JSON.stringify(j)); };
  assert.equal(code(() => parseLicenceFile(raw((j) => (j.limits.sensors = null), false))), "NOT_A_LICENCE", "v1 has no unlimited");
  for (const [name, f] of [["format_version 3", (j: any) => (j.format_version = 3)], ["missing retention", (j: any) => delete j.limits.retention_days], ["extra limit", (j: any) => (j.limits.pumps = 1)], ["reports 0", (j: any) => (j.limits.reports_days = 0)], ["retention 9999", (j: any) => (j.limits.retention_days = 9999)], ["float", (j: any) => (j.limits.gateways = 1.5)], ["string", (j: any) => (j.limits.sensors = "unlimited")]] as [string, (j: any) => void][]) assert.equal(code(() => parseLicenceFile(raw(f))), "NOT_A_LICENCE", name);
  const t = raw((j) => (j.limits.sensors = 99999)); assert.equal(code(() => checkLicence(t, KEYS, DEV)), "BAD_SIGNATURE", "changing a limit breaks the signature");
  const unl = raw((j) => (j.limits.sensors = null)); assert.equal(code(() => checkLicence(unl, KEYS, DEV)), "BAD_SIGNATURE", "turning a number into unlimited breaks it too");
  const dropped = raw((j) => delete j.format_version); assert.equal(code(() => parseLicenceFile(dropped)), "NOT_A_LICENCE");
});
test("ENGINEERING: format 2, every limit null, no expiry; anything else is refused", () => {
  for (const [name, p] of [["a limit set", eng({ limits: { gateways: 1, sensors: null, reports_days: null, retention_days: null } })], ["an expiry", eng({ valid_until: "2099-01-01T00:00:00Z" })], ["format 1", { ...v1p({ type: "ENGINEERING" }) }]] as [string, LicencePayload][]) assert.equal(code(() => parseLicenceFile(Buffer.from(signLicence(p, KEY.privateKey)))), "NOT_A_LICENCE", name);
});
test("service: ENGINEERING is unlimited everywhere (sensors, gateways, charts and CSV reach, history kept) and reads 'ENGINEERING LICENCE'; null never trips a check", () => {
  const { db, lic } = svc(); assert.deepEqual([lic.summary().reports_days, lic.summary().retention_days], [7, 90], "FREE numbers");
  const s = lic.install(A, file(eng())); assert.equal(s.state, "LICENSED"); assert.equal(s.type, "ENGINEERING"); assert.deepEqual(s.limits, { gateways: null, sensors: null }); assert.equal(s.over_limit, false); assert.deepEqual([s.reports_days, s.retention_days], [null, null]);
  assert.equal(lic.reportsDays(), null); assert.equal(lic.retentionDays(), null);
  assert.doesNotThrow(() => lic.checkSensorsAdd(100000)); assert.doesNotThrow(() => lic.checkGatewayAdd(500)); assert.doesNotThrow(() => lic.checkSensorsTotal(99999)); assert.doesNotThrow(() => lic.checkSend(99999, 5));
  for (let i = 0; i < 25; i++) db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at) VALUES(?,?,?,5,1)").run(String(112600000 + i), "th", i + 1); assert.equal(lic.summary().over_limit, false, "25 sensors on an unlimited licence: not over");
  assert.equal(lic.remove(A).state, "FREE"); assert.throws(() => lic.checkSensorsAdd(1), /allows 10 sensors/, "removing it brings the FREE limits back (25 > 10: adding is refused)");
});
test("service: numeric v2 limits are enforced, partial null works (sensors unlimited, gateways 2), v1 licence gets retention 365 and unlimited reports, an expired v2 falls back to FREE numbers", () => {
  const a = svc(); a.lic.install(A, file(base({ limits: { gateways: 2, sensors: null, reports_days: 30, retention_days: 200 } }))); assert.doesNotThrow(() => a.lic.checkSensorsAdd(9999)); assert.throws(() => a.lic.checkGatewayAdd(3), /allows 2 gateways/);
  assert.deepEqual([a.lic.reportsDays(), a.lic.retentionDays()], [30, 200]);
  const b = svc(); b.lic.install(A, Buffer.from(signLicence(v1p(), KEY.privateKey))); assert.deepEqual([b.lic.reportsDays(), b.lic.retentionDays()], [null, 365], "v1: no reports limit inside retention, kept 365 days");
  const c = svc(); c.lic.install(A, file(base({ valid_until: "2026-11-18T00:00:00Z" }))); assert.equal(c.lic.summary().state, "LICENSED"); (c.lic as any).now = () => Date.parse("2026-12-01T00:00:00Z");
  const e = c.lic.summary(); assert.equal(e.state, "EXPIRED"); assert.deepEqual([e.reports_days, e.retention_days, e.limits.sensors], [FREE_LICENCE.reportsDays, FREE_LICENCE.retentionDays, 10]);
});
test("retention: removes raw AND hourly rows older than the licence's days, keeps newer ones, null = never prune, audited, driven by the licence at every run", async () => {
  const mk = () => { const db = openDb(":memory:"); db.prepare("INSERT INTO series(id,topic,sensor_key,metric) VALUES(1,'gateway/th','1','temperature')").run(); const now = Date.parse("2026-11-17T12:00:00Z"), D = 86_400_000;
    for (const age of [200, 100, 91, 89, 30, 1]) { db.prepare("INSERT INTO history_raw(series_id,ts,value) VALUES(1,?,20)").run(now - age * D); db.prepare("INSERT INTO rollup_hourly(series_id,hour_ts,avg,min,max,n) VALUES(1,?,20,20,20,1)").run(Math.floor((now - age * D) / 3_600_000) * 3_600_000); }
    return { db, now, count: (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c }; };
  const x = mk(); const removed = await runRetention(x.db, 90, x.now); assert.ok(removed >= 6, "3 raw + 3 hourly (the rollup job may add one hour)"); assert.equal(x.count("history_raw"), 3); assert.deepEqual((x.db.prepare("SELECT MIN(ts) m FROM history_raw").get() as any).m, x.now - 89 * 86_400_000);
  assert.ok((x.db.prepare("SELECT COUNT(*) c FROM rollup_hourly WHERE hour_ts < ?").get(x.now - 90 * 86_400_000) as any).c === 0, "no hourly row older than 90 days"); assert.equal(x.count("rollup_hourly") >= 3, true);
  const a = JSON.parse((x.db.prepare("SELECT detail FROM audit_log WHERE action='retention.prune'").get() as any).detail); assert.equal(a.days, 90); assert.equal(a.raw_rows, 3);
  const n = mk(); assert.equal(await runRetention(n.db, null, n.now), 0); assert.equal(n.count("history_raw"), 6, "null: nothing is pruned"); assert.equal(n.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='retention.prune'").get().c, 0);
  const { lic } = svc(); assert.equal(lic.retentionDays(), 90); lic.install(A, file(eng())); assert.equal(lic.retentionDays(), null, "installing ENGINEERING stops pruning at the next run, no restart");
  assert.equal(config.retentionDays, null, "RETENTION_DAYS is an override only; unset = the licence decides"); assert.match(readFileSync("src/index.ts", "utf8"), /config\.retentionDays \?\? lic\.retentionDays\(\)/);
});
test("dev-1 verifies only in non-release builds; a release build trusts production keys only; --release needs a production key", async () => {
  assert.ok("dev-1" in trustedKeys(false)); assert.ok(!("dev-1" in trustedKeys(true))); assert.deepEqual(Object.keys(trustedKeys(true)).sort(), Object.keys(PROD_KEYS).sort()); assert.ok("dev-1" in LICENCE_PUBLIC_KEYS, "this (non-release) test run trusts dev-1");
  assert.ok(Object.values({ ...PROD_KEYS, ...DEV_KEYS }).every((k) => !/PRIVATE/.test(k)));
  const dev1 = DEV_KEYS["dev-1"]; const s = svc().db; const rel = new LicenceService(s, { dataDir: mkdtempSync(join(tmpdir(), "fp-rel-")), keys: trustedKeys(true), deviceId: () => DEV }); const f = Buffer.from(signLicence(base({ key_id: "dev-1" }), KEY.privateKey));
  assert.throws(() => rel.install(A, f), /signed with a key this box does not know/, "a release build refuses a dev-1 licence"); void dev1;
  // regression (bench, 2026-11-17): `released` in BUILD.json is the build DATE of every build, so it cannot mean "release". Only `release: true` (set by --release) switches dev-1 off.
  const { makeStamp } = await import("../scripts/build-stamp.mjs"); assert.equal(makeStamp({ hash: "abc", dirty: false, release: false }).release, false); assert.equal(makeStamp({ hash: "abc", dirty: false, release: true }).release, true); assert.match(makeStamp({ hash: "abc", dirty: false, release: false }).released, /^\d{4}-\d\d-\d\d$/);
  const { readBuild } = await import("../src/about/build.js"); const dd = mkdtempSync(join(tmpdir(), "fp-bld-")); writeFileSync(join(dd, "BUILD.json"), JSON.stringify({ build: "x", released: "2026-11-17", dirty: false, release: false })); assert.equal(readBuild(dd, dd).release, false, "a dated non-release stamp is not a release"); writeFileSync(join(dd, "BUILD.json"), JSON.stringify({ build: "x", released: "2026-11-17", dirty: false, release: true })); assert.equal(readBuild(dd, dd).release, true); writeFileSync(join(dd, "BUILD.json"), JSON.stringify({ build: "x", released: "2026-11-17", dirty: false })); assert.equal(readBuild(dd, dd).release, false, "an old stamp without the field is not a release");
  assert.match(readFileSync("deploy.sh", "utf8"), /RELEASE refused: src\/licence\/keys\.ts has no production public key/);
  const r = spawnSync("bash", ["-c", 'grep -Eq \'^[[:space:]]*"prod-[0-9]+":\' src/licence/keys.ts && echo has || echo none'], { encoding: "utf8" }); assert.equal(r.stdout.trim(), Object.keys(PROD_KEYS).length ? "has" : "none", "the guard in deploy.sh matches the file as it is");
});

// ---------- issuing tool ----------
const tool = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", "tools/licence-issue/index.ts", ...a], { encoding: "utf8" });
function keyDir() { const d = mkdtempSync(join(tmpdir(), "fp-bt-")); assert.equal(tool("keygen", "--key-id", "bt-1", "--out", d).status, 0); return { d, key: join(d, "bt-1.private.pem"), pub: readFileSync(join(d, "bt-1.public.txt"), "utf8").trim() }; }
const csv = (d: string, text: string) => { const f = join(d, "devices.csv"); writeFileSync(f, text); return f; };
test("batch: one file per row, CSV quoting, blank valid_until = no expiry, limit columns and defaults, a table, zip, files verify, the key is never printed", () => {
  const { d, key, pub } = keyDir(), out = join(d, "out"); const privText = readFileSync(key, "utf8");
  const c = csv(d, '﻿device_id,licensed_to,valid_until,sensors,reports_days\r\nFP-1111-2222-3333,"Al Maimoon, Farm A",,100,\r\nFP-4444-5555-6666,Farm B,2099-06-30,unlimited,30\r\n');
  const r = tool("--batch", c, "--type", "PRO", "--key", key, "--key-id", "bt-1", "--out", out, "--zip", "--gateways", "2", "--seq", "5"); assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!(r.stdout + r.stderr).includes(privText.split("\n")[1]), "the private key is never printed"); assert.ok(!/PRIVATE KEY/.test(r.stdout + r.stderr));
  const names = readdirSync(out).sort(); assert.deepEqual(names, ["al-maimoon-farm-a-FP-1111-2222-3333.fplic", "farm-b-FP-4444-5555-6666.fplic", names.find((n) => n.endsWith(".zip"))!].sort());
  const a = JSON.parse(readFileSync(join(out, names[0]), "utf8")), b = JSON.parse(readFileSync(join(out, "farm-b-FP-4444-5555-6666.fplic"), "utf8"));
  assert.equal(a.licensed_to, "Al Maimoon, Farm A"); assert.equal(a.valid_until, null); assert.deepEqual(a.limits, { gateways: 2, sensors: 100, reports_days: 365, retention_days: 365 }); assert.match(a.licence_id, /^FPL-\d{8}-0005$/);
  assert.equal(b.valid_until, "2099-06-30T23:59:59Z"); assert.deepEqual(b.limits, { gateways: 2, sensors: null, reports_days: 30, retention_days: 365 }); assert.match(b.licence_id, /-0006$/); assert.equal(a.type, "PRO");
  for (const [n, dev] of [[names[0], "FP-1111-2222-3333"], ["farm-b-FP-4444-5555-6666.fplic", "FP-4444-5555-6666"]]) assert.equal(checkLicence(readFileSync(join(out, n)), { "bt-1": pub }, dev).type, "PRO");
  assert.match(r.stdout, /issued 2 licence\(s\)/); assert.match(r.stdout, /file\s+licence_id\s+device_id\s+licensed_to\s+type\s+gateways\s+sensors/); assert.match(r.stdout, /Farm B\s+PRO\s+2\s+unlimited\s+30\s+365\s+2099-06-30T23:59:59Z/);
  const z = spawnSync("unzip", ["-l", join(out, names.find((n) => n.endsWith(".zip"))!)], { encoding: "utf8" }); if (z.status === 0) assert.match(z.stdout, /FP-4444-5555-6666\.fplic/);
  assert.equal(tool("batch", "--csv", c, "--type", "PRO", "--key", key, "--key-id", "bt-1", "--out", out, "--gateways", "2").status, 2, "never overwrites an issued licence");
});
test("batch refuses bad input and writes NOTHING: bad Device ID, duplicates, missing limits, unknown column, past expiry, key inside the repo, ENGINEERING with limits", () => {
  const { d, key } = keyDir(); const run = (text: string, ...extra: string[]) => { const out = join(d, "o" + Math.random().toString(16).slice(2)); const r = tool("batch", "--csv", csv(d, text), "--key", key, "--key-id", "bt-1", "--out", out, ...extra); return { r, out, wrote: existsSync(out) ? readdirSync(out).length : 0 }; };
  const H = "device_id,licensed_to,valid_until\n";
  let x = run(H + "FP-1111-2222-3333,A,\nFP-12,B,\n", "--type", "PRO", "--gateways", "1", "--sensors", "5"); assert.equal(x.r.status, 2); assert.match(x.r.stderr, /CSV line 3: Device ID "FP-12" must look like FP-XXXX-XXXX-XXXX/); assert.equal(x.wrote, 0, "a bad second row writes no file at all");
  x = run(H + "FP-1111-2222-3333,A,\nfp-1111-2222-3333,B,\n", "--type", "PRO", "--gateways", "1", "--sensors", "5"); assert.match(x.r.stderr, /duplicate of line 2/); assert.equal(x.wrote, 0);
  x = run(H + "FP-1111-2222-3333,A,\n", "--type", "PRO"); assert.match(x.r.stderr, /gateways and sensors are required/); x = run(H.replace("valid_until", "valid_until,color") + "FP-1111-2222-3333,A,,red\n", "--type", "PRO"); assert.match(x.r.stderr, /unknown CSV column "color"/);
  x = run(H + "FP-1111-2222-3333,A,2020-01-01\n", "--type", "PRO", "--gateways", "1", "--sensors", "5"); assert.match(x.r.stderr, /already in the past/); x = run("device_id,licensed_to\nFP-1111-2222-3333,A\n", "--type", "PRO"); assert.match(x.r.stderr, /needs the column "valid_until"/);
  x = run(H + "FP-1111-2222-3333,A,\n", "--type", "ENGINEERING", "--sensors", "5"); assert.match(x.r.stderr, /ENGINEERING takes no limits/); x = run(H + "FP-1111-2222-3333,A,2099-01-01\n", "--type", "ENGINEERING"); assert.match(x.r.stderr, /ENGINEERING has no expiry/);
  const inRepo = tool("batch", "--csv", csv(d, H + "FP-1111-2222-3333,A,\n"), "--type", "ENGINEERING", "--key", join(process.cwd(), "web", "k.pem"), "--key-id", "bt-1", "--out", join(d, "x")); assert.match(inRepo.stderr, /inside the repository/);
});
test("sign: ENGINEERING needs no limits, writes format 2 with every limit null and no expiry; PRO accepts 'unlimited'; the file installs and reads as unlimited", () => {
  const { d, key, pub } = keyDir(), out = join(d, "e.fplic"); const r = tool("sign", "--key", key, "--key-id", "bt-1", "--device", DEV, "--licensed-to", "Trident Labs bench", "--type", "ENGINEERING", "--out", out); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ENGINEERING for Trident Labs bench.*gateways unlimited, sensors unlimited, reports unlimited d, history kept unlimited d, valid until no expiry/);
  const f = JSON.parse(readFileSync(out, "utf8")); assert.equal(f.format_version, 2); assert.deepEqual(f.limits, { gateways: null, sensors: null, reports_days: null, retention_days: null }); assert.equal(f.valid_until, null);
  const v = tool("verify", out, "--public-key", pub, "--device", DEV); assert.equal(v.status, 0, v.stdout); assert.match(v.stdout, /gateways unlimited, sensors unlimited, reports unlimited d, history kept unlimited d/);
  const lic = new LicenceService(openDb(":memory:"), { dataDir: mkdtempSync(join(tmpdir(), "fp-e-")), keys: { "bt-1": pub }, deviceId: () => DEV }); assert.equal(lic.install(A, readFileSync(out)).type, "ENGINEERING");
  assert.equal(tool("sign", "--key", key, "--key-id", "bt-1", "--device", DEV, "--licensed-to", "X", "--type", "ENGINEERING", "--sensors", "5", "--out", join(d, "n.fplic")).status, 2);
  const p = tool("sign", "--key", key, "--key-id", "bt-1", "--device", DEV, "--licensed-to", "X", "--type", "PRO", "--gateways", "unlimited", "--sensors", "40", "--retention-days", "unlimited", "--out", join(d, "p.fplic")); assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(readFileSync(join(d, "p.fplic"), "utf8")).limits, { gateways: null, sensors: 40, reports_days: 365, retention_days: null });
});
test("tools README documents ENGINEERING (Trident machines only), batch mode and the production key flow; docs describe format 2", () => {
  const r = readFileSync("tools/licence-issue/README.md", "utf8"); assert.match(r, /ENGINEERING/); assert.match(r, /Trident (Labs )?machines only/i); assert.match(r, /--batch/); assert.match(r, /devices\.csv/); assert.match(r, /valid_until/);
  assert.match(readFileSync("docs/licence-format.md", "utf8"), /Format 2/); const k = readFileSync("docs/licence-production-keys.md", "utf8"); assert.match(k, /keygen --key-id prod-1/); assert.match(k, /dev-1[\s\S]*release/i); assert.match(k, /offline/i);
});

// ---------- web + HTTP ----------
test("web: 'unlimited' wording and checks, ENGINEERING LICENCE (never PRO) in the header chip and on About", () => {
  assert.equal(limitWord(null), "unlimited"); assert.equal(limitWord(10), "10"); assert.equal(atOrOver(10, null), false); assert.equal(atOrOver(10, 10), true); assert.equal(wouldExceed(10, 5, null), false); assert.equal(wouldExceed(9, 2, 10), true);
  assert.equal(licWord({ state: "LICENSED", type: "ENGINEERING" }), "ENGINEERING LICENCE"); assert.equal(licWord({ state: "LICENSED", type: "PRO" }), "PRO"); assert.equal(licWord({ state: "FREE", type: "FREE" }), "FREE"); assert.ok(isEngineering({ state: "LICENSED", type: "ENGINEERING" }) && !isEngineering({ state: "EXPIRED", type: "ENGINEERING" }));
  const about = readFileSync("web/src/About.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), sp = readFileSync("web/src/SensorsPage.tsx", "utf8");
  assert.match(about, /\{n\} of \{limitWord\(max\)\}/); assert.match(about, /licWord\(lic\)/); assert.match(about, /ENGINEERING LICENCE/); assert.match(app, /isEngineering\(licInfo\)/); assert.match(app, /core-licence/); assert.match(sp, /limitWord\(lic\.limits\.sensors\)/); assert.match(sp, /wouldExceed\(/);
});
const map = loadRegMap("config/gateway-thingsend.yaml"); const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
test("over HTTP: upload an ENGINEERING licence on About's endpoint -> /api/about shows type ENGINEERING with null limits and unlimited reach; Operator may read it; removing restores FREE", async () => {
  const db = openDb(":memory:"), ingest = new Ingest(db), reg = new Registry(db, map), gw = new GatewayService(db, reg, ingest, null); const lic = new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-h-")), keys: KEYS, deviceId: () => DEV });
  const { app } = await buildApp(db, ingest, new Commands(db, { publish() {} } as any, () => {}), reg, gw, null, null, lic); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => void app.close()); const port = (app.server.address() as AddressInfo).port;
  const mk = (n: string, role: string) => ({ cookie: "core_session=" + createSession(db, Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,1)").run(n, hashPassword("x".repeat(10)), role).lastInsertRowid)) }); const admin = mk("admin", "admin"), op = mk("op", "operator");
  const call = async (who: { cookie: string }, method: string, url: string, body?: Buffer) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie: who.cookie, ...(body ? { "content-type": "application/octet-stream" } : {}) }, body }); const t = await r.text(); return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  assert.equal((await call(op, "POST", "/api/licence", file(eng()))).status, 403, "Operators cannot upload");
  const up = await call(admin, "POST", "/api/licence", file(eng())); assert.equal(up.status, 200, JSON.stringify(up.json)); const ab = (await call(op, "GET", "/api/about")).json.licence;
  assert.equal(ab.type, "ENGINEERING"); assert.equal(ab.state, "LICENSED"); assert.deepEqual(ab.limits, { gateways: null, sensors: null }); assert.equal(ab.over_limit, false); assert.deepEqual([ab.reports_days, ab.retention_days], [null, null]);
  const meta = (await call(op, "GET", "/api/reports/meta")).json; assert.equal(meta.reports_days, null); assert.ok(meta.ranges.every((r: any) => r.allowed));
  assert.equal((await call(admin, "DELETE", "/api/licence")).json.state, "FREE"); assert.equal((await call(op, "GET", "/api/about")).json.licence.reports_days, 7);
});
