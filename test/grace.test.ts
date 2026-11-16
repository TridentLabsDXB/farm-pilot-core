import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-17 -- Downgrade grace. When a valid PRO / ENGINEERING licence expires cleanly or is removed on purpose, history older than the FREE limit (90 days) is kept for 30 more days, then
// the normal retention job prunes it. A new valid licence during the grace cancels it. An INVALID licence never starts the clock and never prunes. Seeded history, a movable clock.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { openDb, type Db } from "../src/db.js"; import { signLicence, type LicencePayload } from "../src/licence/format.js"; import { LicenceService } from "../src/licence/service.js";
import { runLicenceRetention } from "../src/retention.js"; import { rig } from "./rig.js";

const DEV = "FP-AAAA-BBBB-CCCC", KEY = generateKeyPairSync("ed25519"), KEYS = { "t-1": (KEY.publicKey as KeyObject).export({ type: "spki", format: "der" }).toString("base64") };
const D = 86_400_000, T0 = Date.parse("2026-11-17T12:00:00Z"), A = { username: "admin", role: "admin" };
const pro = (id: string, until: string | null, o: Partial<LicencePayload> = {}): LicencePayload => ({ format_version: 2, licence_id: id, type: "PRO", licensed_to: "Grace Farm", device_id: DEV, limits: { gateways: 2, sensors: 50, reports_days: 365, retention_days: 365 }, features: [], issued_at: "2026-11-17T10:00:00Z", valid_until: until, key_id: "t-1", ...o } as LicencePayload);
const eng = (id: string) => pro(id, null, { type: "ENGINEERING", limits: { gateways: null, sensors: null, reports_days: null, retention_days: null } });
const file = (p: LicencePayload) => Buffer.from(signLicence(p, KEY.privateKey));
const AGES = [200, 100, 91, 89, 30, 1];          // days before T0
function mk(clockAt = T0) {
  const db = openDb(":memory:"), clock = { t: clockAt }, dir = mkdtempSync(join(tmpdir(), "fp-grace-"));
  db.prepare("INSERT INTO series(id,topic,sensor_key,metric) VALUES(1,'gateway/th','1','temperature')").run();
  for (const age of AGES) { db.prepare("INSERT INTO history_raw(series_id,ts,value) VALUES(1,?,20)").run(T0 - age * D); db.prepare("INSERT INTO rollup_hourly(series_id,hour_ts,avg,min,max,n) VALUES(1,?,20,20,20,1)").run(Math.floor((T0 - age * D) / 3_600_000) * 3_600_000); }
  const open = (d: Db = db) => new LicenceService(d, { dataDir: dir, keys: KEYS, deviceId: () => DEV, now: () => clock.t });
  const raw = () => (db.prepare("SELECT ts FROM history_raw ORDER BY ts").all() as { ts: number }[]).map((r) => Math.round((T0 - r.ts) / D));      // ages still present
  const acts = () => (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'licence.grace%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
  const prune = () => runLicenceRetention(db, lic, null); const lic = open();
  return { db, clock, dir, lic, open, raw, acts, prune };
}
const PRO_UNTIL = new Date(T0 + 10 * D).toISOString().replace(".000Z", "Z"), EXPIRED_AT = T0 + 10 * D + 3_600_000;           // the box notices the expiry one hour after valid_until

test("expiry: day 0, 1 and 29 delete nothing; after 30 days exactly the rows older than 90 days go, and only those", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", PRO_UNTIL))); assert.equal(x.lic.retentionDays(), 365);
  x.clock.t = EXPIRED_AT; x.lic.refresh(); assert.equal(x.lic.summary().state, "EXPIRED"); assert.deepEqual(x.acts(), ["licence.grace_started"]);
  const g = x.lic.summary().grace!; assert.equal(g.downgrade_at, new Date(EXPIRED_AT).toISOString()); assert.equal(g.delete_on, new Date(EXPIRED_AT + 30 * D).toISOString());
  for (const day of [0, 1, 29]) { x.clock.t = EXPIRED_AT + day * D; assert.equal(await x.prune(), 0, `day ${day}`); assert.deepEqual(x.raw(), AGES, `day ${day}: all 6 raw rows kept, including those older than 90 days`); assert.equal(x.lic.retentionDays(), null); }
  assert.equal(x.lic.summary().retention_days, 90, "the FREE limit is still what the summary states");
  x.clock.t = EXPIRED_AT + 30 * D; const n = await x.prune(); assert.ok(n >= 8, "4 raw + 4 hourly at least"); assert.deepEqual(x.raw(), [30, 1], "only rows older than 90 days at that moment are gone");
  assert.equal((x.db.prepare("SELECT COUNT(*) c FROM rollup_hourly WHERE hour_ts < ?").get(x.clock.t - 90 * D) as any).c, 0);
  const a = JSON.parse((x.db.prepare("SELECT detail FROM audit_log WHERE action='licence.grace_prune'").get() as any).detail);
  assert.equal(a.history_raw, 4); assert.ok(a.rollup_hourly >= 4); assert.equal(a.cutoff, new Date(x.clock.t - 90 * D).toISOString()); assert.equal(a.downgrade_at, new Date(EXPIRED_AT).toISOString());
  assert.equal(x.lic.summary().grace, null, "the notice ends once the prune has run"); assert.equal(x.lic.retentionDays(), 90, "from now on the plain FREE limit applies");
  assert.deepEqual(x.acts(), ["licence.grace_started", "licence.grace_prune"]);
});

test("a retention run that happens before the daily licence check still cannot prune a just-expired licence (the clock is recorded first)", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", PRO_UNTIL))); x.clock.t = EXPIRED_AT + D;      // expired a day ago, refresh() has not run since
  assert.equal(await x.prune(), 0); assert.deepEqual(x.raw(), AGES); assert.deepEqual(x.acts(), ["licence.grace_started"]);
});

test("a new valid licence at day 10 cancels the grace; at day 31 nothing is deleted and no notice is left", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", PRO_UNTIL))); x.clock.t = EXPIRED_AT; x.lic.refresh();
  x.clock.t = EXPIRED_AT + 10 * D; const s = x.lic.install(A, file(pro("FPL-20261117-0002", null))); assert.equal(s.state, "LICENSED"); assert.equal(s.grace, null);
  x.clock.t = EXPIRED_AT + 31 * D; assert.equal(await x.prune(), 0); assert.deepEqual(x.raw(), AGES); assert.equal(x.lic.retentionDays(), 365);
  assert.deepEqual(x.acts(), ["licence.grace_started", "licence.grace_cancelled"]);
  const c = JSON.parse((x.db.prepare("SELECT detail FROM audit_log WHERE action='licence.grace_cancelled'").get() as any).detail); assert.equal(c.licence_id, "FPL-20261117-0002"); assert.equal(c.was_downgrade_at, new Date(EXPIRED_AT).toISOString());
});

test("INVALID (bad signature, unreadable, missing file) never starts the clock and never prunes; FREE limits still apply for usage; the state recovers when the file is valid again", async () => {
  for (const how of ["garbage", "missing", "tampered"]) {
    const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", null))); const path = join(x.dir, "licence", "current.fplic"), good = readFileSync(path);
    if (how === "garbage") writeFileSync(path, "not a licence"); else if (how === "missing") rmSync(path); else { const j = JSON.parse(good.toString()); j.limits.sensors = 99999; writeFileSync(path, JSON.stringify(j)); }
    x.lic.refresh(); const s = x.lic.summary(); assert.equal(s.state, "INVALID", how); assert.equal(s.limits.sensors, 10, "FREE limits for usage"); assert.equal(s.grace, null);
    for (const day of [0, 1, 40, 400]) { x.clock.t = T0 + day * D; assert.equal(await x.prune(), 0, `${how} day ${day}`); assert.equal(x.raw().length, 6); }
    assert.equal(x.lic.retentionDays(), null); assert.deepEqual(x.acts(), [], `${how}: no downgrade_at, no grace audit`); assert.equal((x.db.prepare("SELECT value FROM settings WHERE key='licence.downgrade_at'").get() as any), undefined);
    writeFileSync(path, good); x.lic.refresh(); assert.equal(x.lic.summary().state, "LICENSED", `${how}: valid again`);
  }
});

test("ENGINEERING (null retention) never prunes; removing it starts the grace exactly like PRO", async () => {
  const x = mk(); x.lic.install(A, file(eng("FPL-20261117-0003"))); assert.equal(x.lic.retentionDays(), null); x.clock.t = T0 + 900 * D; assert.equal(await x.prune(), 0); assert.equal(x.raw().length, 6); assert.deepEqual(x.acts(), []);
  x.clock.t = T0; const s = x.lic.remove(A); assert.equal(s.state, "FREE"); assert.equal(s.grace!.downgrade_at, new Date(T0).toISOString()); assert.deepEqual(x.acts(), ["licence.grace_started"]);
  assert.equal(JSON.parse((x.db.prepare("SELECT detail FROM audit_log WHERE action='licence.grace_started'").get() as any).detail).reason, "removed");
  for (const day of [0, 1, 29]) { x.clock.t = T0 + day * D; assert.equal(await x.prune(), 0, `day ${day}`); assert.equal(x.raw().length, 6); }
  x.clock.t = T0 + 30 * D; assert.ok(await x.prune() > 0); assert.deepEqual(x.raw(), [30, 1], "cutoff at day 30 is T0-60d: the rows 200, 100, 91 and 89 days old are gone");
  assert.deepEqual(x.acts(), ["licence.grace_started", "licence.grace_prune"]);
  // removing a PRO does the same
  const y = mk(); y.lic.install(A, file(pro("FPL-20261117-0001", null))); y.lic.remove(A); assert.ok(y.lic.summary().grace); assert.deepEqual(y.acts(), ["licence.grace_started"]);
});

test("a restart during the grace keeps downgrade_at (and the prune date); the restarted service prunes at day 30", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", null))); x.lic.remove(A); const before = x.lic.summary().grace!;
  x.clock.t = T0 + 15 * D; const again = x.open(); assert.deepEqual(again.summary().grace, before); assert.equal(again.retentionDays(), null); assert.deepEqual(x.acts(), ["licence.grace_started"], "no second start after the restart");
  x.clock.t = T0 + 30 * D; const lic2 = x.open(); assert.equal(lic2.graceEnded(), true); assert.ok(await runLicenceRetention(x.db, lic2, null) > 0); assert.deepEqual(x.raw(), [30, 1]);
  assert.equal(lic2.summary().grace, null);
  const z = x.open(); assert.equal(z.summary().grace, null, "a restart after the prune does not bring the notice back"); assert.equal(z.graceEnded(), false);
});

test("replacing a valid PRO with a different valid PRO never starts the clock; a box that never had a licence is plain FREE (no grace, prunes at 90 as before)", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", null))); x.lic.install(A, file(pro("FPL-20261117-0002", PRO_UNTIL))); x.lic.install(A, file(eng("FPL-20261117-0003")));
  assert.deepEqual(x.acts(), []); assert.equal(x.lic.summary().grace, null); assert.equal((x.db.prepare("SELECT value FROM settings WHERE key='licence.downgrade_at'").get() as any), undefined);
  const f = mk(); assert.equal(f.lic.summary().state, "FREE"); assert.equal(f.lic.summary().grace, null); assert.equal(f.lic.retentionDays(), 90); assert.ok(await f.prune() >= 6, "3 raw + 3 hourly"); assert.deepEqual(f.raw(), [89, 30, 1]); assert.deepEqual(f.acts(), []);
});

test("an already running grace is not restarted by removing the expired licence file", async () => {
  const x = mk(); x.lic.install(A, file(pro("FPL-20261117-0001", PRO_UNTIL))); x.clock.t = EXPIRED_AT; x.lic.refresh(); const g = x.lic.summary().grace!;
  x.clock.t = EXPIRED_AT + 5 * D; assert.deepEqual(x.lic.remove(A).grace, g); assert.deepEqual(x.acts(), ["licence.grace_started"]);
});

test("About API: the grace notice data is sent to Admin only; an Operator gets no grace key at all", async () => {
  const db = openDb(":memory:"), clock = { t: T0 }, lic = new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-grace-")), keys: KEYS, deviceId: () => DEV, now: () => clock.t });
  const x = await rig({ db, lic }); after(x.close); lic.install(A, file(pro("FPL-20261117-0001", null))); lic.remove(A);
  const ad = (await x.call(x.admin, "GET", "/api/about")).json, op = await x.call(x.op, "GET", "/api/about");
  assert.equal(ad.licence.grace.delete_on, new Date(T0 + 30 * D).toISOString()); assert.ok(!("grace" in op.json.licence) && !op.txt.includes("downgrade_at") && !op.txt.includes("delete_on"));
});

test("wiring (source): the scheduled retention uses the licence-aware runner", () => {
  const idx = readFileSync("src/index.ts", "utf8"); assert.ok(!/runRetention\(/.test(idx)); assert.equal((idx.match(/runLicenceRetention\(db, lic\)/g) ?? []).length, 2);
});

test("UI (source): Admin-only amber notice with the delete date in the Farm Profile zone, the REMOVE dialog names the consequence, the INVALID notice says nothing is deleted", () => {
  const ab = readFileSync("web/src/About.tsx", "utf8");
  assert.match(ab, /\{admin && lic\.grace && <div className="ab-notice"/); assert.match(ab, /History older than \{FREE_RETENTION_DAYS\} days will be deleted on <strong>\{dateOnly\(Date\.parse\(lic\.grace\.delete_on\)\)\}<\/strong>\. Upload a PRO licence to keep it\./);
  assert.match(ab, /const FREE_RETENTION_DAYS = 90;/); assert.ok(!/lic\.retention_days \?\? 90/.test(ab), "the dialog must not quote the PRO licence's own retention");
  assert.match(ab, /Back to FREE limits\. History older than \{FREE_RETENTION_DAYS\} days is kept for 30 days, then deleted\./);
  assert.match(ab, /\{admin && lic\.state === "INVALID" && <div className="ab-notice"/); assert.match(ab, /No history is deleted while the licence is invalid/);
  assert.match(readFileSync("web/src/ui.tsx", "utf8"), /export const dateOnly = .*zoneParts/, "dateOnly formats in the Farm Profile time zone");
});
