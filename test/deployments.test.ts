import "./isolate.js";   // test data folder is a temp dir
// Licence Management (Online build only, 2026-11-17): status rules, usage flags, Admin-only API, Online vs standalone, audit, record-only behaviour.
import test, { after } from "node:test"; import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rig } from "./rig.js";
import { deploymentStatus, usageFlag, termPct, sortByExpiry, effectiveLimits, FREE_LIMITS } from "../src/deployments/calc.js";
import { FREE_LICENCE } from "../src/licence/free.js";
import { TIERS } from "../src/deployments/tiers.js";
import { nextLicenceId, licenceIdError, DEVICE_ID_MSG } from "../web/src/licenceId.js";

const NOW = Date.parse("2026-11-17T10:00:00Z"), D = 86_400_000, iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const eod = (daysFromToday: number) => iso(Date.parse("2026-11-17T23:59:59Z") + daysFromToday * D);   // expiry stored as the END of a day, like a signed licence
const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const ID = (n: number) => `FP-AAAA-BBBB-${String(n).padStart(4, "0")}`;

test("status: more than 30 days, exactly 30, 0 (today), expired, no expiry, FREE", () => {
  assert.deepEqual(deploymentStatus("PRO", eod(31), NOW), { status: "active", daysLeft: 31 });
  assert.deepEqual(deploymentStatus("PRO", eod(30), NOW), { status: "expiring", daysLeft: 30 }, "30 days is EXPIRING");
  assert.deepEqual(deploymentStatus("PRO", eod(0), NOW), { status: "expiring", daysLeft: 0 }, "expires today but still valid");
  assert.equal(deploymentStatus("PRO", "2026-11-17T10:00:00Z", NOW).status, "expired", "valid only while now < valid_until, as on the box");
  assert.equal(deploymentStatus("PRO", eod(-1), NOW).status, "expired"); assert.ok(deploymentStatus("PRO", eod(-5), NOW).daysLeft! < 0);
  assert.deepEqual(deploymentStatus("ENGINEERING", null, NOW), { status: "active", daysLeft: null });
  assert.deepEqual(deploymentStatus("FREE", null, NOW), { status: "free", daysLeft: null });
});
test("usage flags: AT LIMIT, OVER LIMIT, unlimited; an expired box is judged against the FREE limits (14 sensors against 10 = OVER LIMIT)", () => {
  assert.equal(usageFlag(9, 10), "ok"); assert.equal(usageFlag(10, 10), "at_limit"); assert.equal(usageFlag(11, 10), "over_limit"); assert.equal(usageFlag(99999, null), "ok");
  const lim = { gateways: 5, sensors: 100, reports_days: null, retention_days: 365 };
  assert.deepEqual(effectiveLimits("PRO", lim, "expired"), FREE_LIMITS); assert.deepEqual(effectiveLimits("PRO", lim, "active"), lim);
  assert.deepEqual(FREE_LIMITS, { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors, reports_days: FREE_LICENCE.reportsDays, retention_days: FREE_LICENCE.retentionDays }, "FREE numbers come from licence/free.ts");
});
test("term percentage and sort: expiry ascending, no expiry last", () => {
  assert.equal(termPct("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", Date.parse("2026-07-02T12:00:00Z")), 50); assert.equal(termPct(null, "2027-01-01T00:00:00Z", NOW), null);
  assert.deepEqual(sortByExpiry([{ name: "c", validUntil: null }, { name: "b", validUntil: "2027-01-01T00:00:00Z" }, { name: "a", validUntil: "2026-12-01T00:00:00Z" }]).map((x) => x.name), ["a", "b", "c"]);
});

test("Online build: Admin has the API, Operator gets 403, no login gets 401; the table exists", async () => {
  const x = await rig({ online: true, now: () => NOW }); closers.push(() => void x.close());
  assert.equal((await x.call(x.admin, "GET", "/api/licence-deployments")).status, 200);
  assert.equal((await x.call(x.op, "GET", "/api/licence-deployments")).status, 403);
  for (const [m, u] of [["GET", "/api/licence-deployments/attention"], ["GET", "/api/licence-deployments/1"], ["POST", "/api/licence-deployments"], ["PATCH", "/api/licence-deployments/1"], ["POST", "/api/licence-deployments/1/record"], ["GET", "/api/licence-deployments/1/history"], ["POST", "/api/licence-deployments/1/history"]])
    assert.equal((await x.call(x.op, m, u, m === "GET" ? undefined : {})).status, 403, `Operator ${m} ${u}`);
  assert.equal((await x.call(null, "GET", "/api/licence-deployments")).status, 401);
  assert.equal((await x.call(x.admin, "GET", "/api/me")).json.online, true);
});
test("Standalone build: no route (404), no table, /api/me does not say online", async () => {
  const x = await rig({ online: false }); closers.push(() => void x.close());
  for (const u of ["/api/licence-deployments", "/api/licence-deployments/attention", "/api/licence-deployments/1"]) assert.equal((await x.call(x.admin, "GET", u)).status, 404, u);
  assert.equal((await x.call(x.admin, "POST", "/api/licence-deployments", {})).status, 404);
  assert.equal(x.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'licence_%'").get().c, 0);
  assert.equal((await x.call(x.admin, "GET", "/api/me")).json.online, undefined);
  assert.ok(!x.routes.some((r) => r.url.includes("licence-deployments")));
});

test("create, list, badge count, search data, record (ISSUE then RENEW), history, audit", async () => {
  const x = await rig({ online: true, now: () => NOW }); closers.push(() => void x.close()); const A = x.admin, c = (m: string, u: string, b?: unknown) => x.call(A, m, u, b);
  let r = await c("POST", "/api/licence-deployments", { name: "Greenhouse 1", deviceId: ID(1).toLowerCase(), usedGateways: 1, usedSensors: 14 });
  assert.equal(r.status, 201); assert.equal(r.json.deployment.type, "FREE"); assert.equal(r.json.deployment.status, "free"); assert.equal(r.json.deployment.deviceId, ID(1)); assert.equal(r.json.deployment.usageFlags.sensors, "over_limit"); assert.equal(r.json.deployment.usageFlags.gateways, "at_limit");
  const id1 = r.json.deployment.id;
  assert.equal((await c("POST", "/api/licence-deployments", { name: "dup", deviceId: ID(1) })).status, 409);
  assert.equal((await c("POST", "/api/licence-deployments", { name: "x", deviceId: "nope" })).status, 400);
  assert.equal((await c("POST", "/api/licence-deployments", { name: "", deviceId: ID(9) })).status, 400);
  const mk = async (name: string, n: number, type: string, until: string | null) => { const d = (await c("POST", "/api/licence-deployments", { name, deviceId: ID(n) })).json.deployment.id; if (type !== "FREE") await c("POST", `/api/licence-deployments/${d}/record`, { type, licenceId: `FPL-20260101-${String(n).padStart(4, "0")}`, issuedAt: "2026-01-01", validUntil: until, }); return d; };
  await mk("Soon", 2, "PRO", "2026-12-10"); await mk("Gone", 3, "PRO", "2026-11-01"); await mk("Later", 4, "PRO", "2027-06-30"); await mk("Full", 5, "FULL", null);
  assert.equal((await c("GET", "/api/licence-deployments/attention")).json.count, 2, "EXPIRING + EXPIRED");
  const list = (await c("GET", "/api/licence-deployments")).json.deployments as any[];
  assert.deepEqual(list.map((d) => d.name), ["Gone", "Soon", "Later", "Greenhouse 1"].concat(["Full"]).sort((a, b) => list.findIndex((d) => d.name === a) - list.findIndex((d) => d.name === b)), "sorted by expiry, no expiry last");
  assert.equal(list[0].name, "Gone"); assert.equal(list[0].status, "expired"); assert.deepEqual(list[0].effectiveLimits, FREE_LIMITS);
  assert.equal(list.find((d) => d.name === "Soon").status, "expiring"); assert.equal(list.find((d) => d.name === "Later").status, "active");
  // ISSUE on a FREE box writes ISSUED; RENEW on a licensed box writes RENEWED; both are audited; nothing is signed
  r = await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "FPL-20261117-0001", validUntil: "2027-11-16"});
  assert.equal(r.status, 200); assert.equal(r.json.deployment.type, "PRO"); assert.equal(r.json.deployment.status, "active"); assert.equal(r.json.deployment.validUntil, "2027-11-16T23:59:59Z"); assert.equal(r.json.deployment.usageFlags.sensors, "ok"); assert.deepEqual(r.json.deployment.limits, TIERS.PRO);
  r = await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "FPL-20261117-0002", validUntil: "2028-11-16"}); assert.equal(r.status, 200);
  const h = (await c("GET", `/api/licence-deployments/${id1}/history`)).json.history as any[]; assert.deepEqual(h.map((e) => e.event), ["RENEWED", "ISSUED"]);
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/history`, { event: "INSTALLED", note: "on site" })).status, 201); assert.equal((await c("POST", `/api/licence-deployments/${id1}/history`, { event: "ISSUED" })).status, 400);
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "GOLD", licenceId: "x" })).status, 400); assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "x" })).status, 400, "licence id format");
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "ENGINEERING", licenceId: "FPL-20261117-0003", limitSensors: 5 })).status, 400, "ENGINEERING limits are fixed too (unlimited)");
  assert.equal((await c("PATCH", `/api/licence-deployments/${id1}`, { usedSensors: 5, lastSeen: NOW - 120_000 })).json.deployment.usage.sensors, 5); assert.equal((await c("PATCH", `/api/licence-deployments/${id1}`, {})).status, 400); assert.equal((await c("PATCH", "/api/licence-deployments/999", { name: "z" })).status, 404);
  // the expired box shows a derived EXPIRED history row, never stored
  const gone = list[0].id; assert.equal(((await c("GET", `/api/licence-deployments/${gone}/history`)).json.history as any[])[0].event, "EXPIRED"); assert.equal(x.db.prepare("SELECT COUNT(*) c FROM licence_history WHERE event='EXPIRED'").get().c, 0);
  const acts = (x.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'licence_deployment.%'").all() as { action: string }[]).map((a) => a.action);
  for (const a of ["licence_deployment.create", "licence_deployment.update", "licence_deployment.issued", "licence_deployment.renewed", "licence_deployment.history"]) assert.ok(acts.includes(a), a);
  assert.equal((x.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action LIKE 'licence_deployment.%' AND username='admin'").get() as any).c, acts.length, "every change is attributed");
});

test("source: standalone gating in the web app (no entry, no route) and the Admin-only menu entry", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8");
  assert.match(sb, /g\.title === "System" && online/); assert.match(app, /page === "licences" && admin && me\.online/); assert.match(app, /me\.role !== "admin" \|\| !me\.online\) && page === "licences"\) go\("\/monitoring"\)/);
  assert.match(ab, /g\.title === "System" && admin && online/);
  assert.ok(sb.indexOf('"/licences"') > sb.indexOf("GROUPS.filter"), "the entry sits inside the SYSTEM group, after its items");
  assert.match(sb, /aria-current=\{cur === "licences"/); assert.match(sb, /nLicences > 0/, "badge hidden at 0");
});

const REC = (type: string, extra: object = {}) => ({ type, licenceId: "FPL-20261118-0001", issuedAt: "2026-11-18", validUntil: "2027-11-18", ...extra });
test("tiers: one constant, FREE 1/10, PRO 5/50, FULL 25/250; FREE comes from licence/free.ts; FULL reports/retention shown like PRO until confirmed", () => {
  assert.deepEqual(TIERS.ENGINEERING, { gateways: null, sensors: null, reports_days: null, retention_days: null }, "ENGINEERING: unlimited");
  assert.deepEqual([TIERS.FREE.gateways, TIERS.FREE.sensors, TIERS.PRO.gateways, TIERS.PRO.sensors, TIERS.FULL.gateways, TIERS.FULL.sensors], [1, 10, 5, 50, 25, 250]);
  assert.deepEqual(TIERS.FREE, { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors, reports_days: FREE_LICENCE.reportsDays, retention_days: FREE_LICENCE.retentionDays });
  assert.deepEqual([TIERS.FULL.reports_days, TIERS.FULL.retention_days], [TIERS.PRO.reports_days, TIERS.PRO.retention_days]);
});
test("API: each tier sets its limits; mismatched limits are refused; ENGINEERING is not offered; FREE clears the licence; history text", async () => {
  const x = await rig({ online: true, now: () => NOW }); closers.push(() => void x.close()); const c = (m: string, u: string, b?: unknown) => x.call(x.admin, m, u, b);
  assert.deepEqual((await c("GET", "/api/licence-deployments")).json.tiers, TIERS, "the page gets the table from the server");
  const id = (await c("POST", "/api/licence-deployments", { name: "T", deviceId: ID(7) })).json.deployment.id, rec = (b: object) => c("POST", `/api/licence-deployments/${id}/record`, b);
  for (const t of ["PRO", "FULL", "ENGINEERING"] as const) { const r = await rec(REC(t)); assert.equal(r.status, 200, t); assert.deepEqual(r.json.deployment.limits, TIERS[t]); assert.equal(r.json.deployment.type, t); }
  assert.equal((await rec(REC("FULL", { limitDataSources: 25, limitSensors: 250 }))).status, 200, "matching limits are accepted");
  for (const bad of [{ limitDataSources: 26 }, { limitSensors: 251 }, { limitDataSources: null }, { limitReportsDays: 7 }]) assert.equal((await rec(REC("FULL", bad))).status, 400, JSON.stringify(bad));
  assert.equal((await rec(REC("PRO", { limitDataSources: 25, limitSensors: 250 }))).status, 400, "PRO with FULL limits");
  const h = ((await c("GET", `/api/licence-deployments/${id}/history`)).json.history as any[]);
  assert.equal(h.at(-1).event, "ISSUED"); assert.equal(h.at(-1).note, "PRO, 5 data sources, 50 sensors, until 18 Nov 2027"); assert.equal(h[0].event, "RENEWED");
  assert.equal((await rec(REC("PRO", { validUntil: null, note: "paid" }))).json.deployment.validUntil, null, "no expiry allowed"); assert.equal(((await c("GET", `/api/licence-deployments/${id}/history`)).json.history as any[])[0].note, "PRO, 5 data sources, 50 sensors, no expiry. paid");
  const f = await rec({ type: "FREE" }); assert.equal(f.status, 200); const d = f.json.deployment; assert.deepEqual([d.type, d.licenceId, d.issuedAt, d.validUntil, d.status], ["FREE", null, null, null, "free"]); assert.deepEqual(d.limits, TIERS.FREE);
  assert.equal((await rec({ type: "FREE", limitSensors: 50 })).status, 400, "FREE with PRO limits");
  assert.equal((await c("GET", "/api/licence-deployments/attention")).status, 200);
});
test("usage flags against each tier's limits: exactly at the limit and one above", async () => {
  const x = await rig({ online: true, now: () => NOW }); closers.push(() => void x.close()); const c = (m: string, u: string, b?: unknown) => x.call(x.admin, m, u, b);
  let n = 20; for (const t of ["FREE", "PRO", "FULL"] as const) {
    const id = (await c("POST", "/api/licence-deployments", { name: t, deviceId: ID(++n) })).json.deployment.id; if (t !== "FREE") await c("POST", `/api/licence-deployments/${id}/record`, REC(t, { validUntil: "2027-11-18" }));
    const flags = async (g: number, s: number) => (await c("PATCH", `/api/licence-deployments/${id}`, { usedGateways: g, usedSensors: s })).json.deployment.usageFlags;
    const { gateways: G, sensors: S } = TIERS[t];
    assert.deepEqual(await flags(G - 1 + (G === 1 ? 0 : 0), S - 1), G === 1 ? { gateways: "ok", sensors: "ok" } : { gateways: "ok", sensors: "ok" }); assert.deepEqual(await flags(G, S), { gateways: "at_limit", sensors: "at_limit" }, t + " at limit"); assert.deepEqual(await flags(G + 1, S + 1), { gateways: "over_limit", sensors: "over_limit" }, t + " over limit");
  }
});
test("an existing table with the old type CHECK (first Online build) is rebuilt once, rows and history kept; FULL then works", async () => {
  const { openDb } = await import("../src/db.js"); const { registerDeploymentRoutes } = await import("../src/deployments/routes.js"); const Fastify = (await import("fastify")).default;
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE licence_deployments (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, licensed_to TEXT, licence_id TEXT, type TEXT NOT NULL DEFAULT 'FREE' CHECK (type IN ('FREE','PRO','ENGINEERING')), issued_at TEXT, valid_until TEXT, limits TEXT NOT NULL, usage TEXT NOT NULL, last_seen INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE licence_history (id INTEGER PRIMARY KEY, deployment_id INTEGER NOT NULL REFERENCES licence_deployments(id) ON DELETE CASCADE, ts INTEGER NOT NULL, event TEXT NOT NULL CHECK (event IN ('ISSUED','INSTALLED','RENEWED','NOTE')), note TEXT, username TEXT NOT NULL);
    INSERT INTO licence_deployments(id,device_id,name,type,limits,usage,created_at) VALUES (1,'${ID(1)}','Old','FREE','{}','{"gateways":10,"sensors":100}',1); INSERT INTO licence_history(deployment_id,ts,event,note,username) VALUES (1,1,'NOTE','kept','admin');`);
  const app = Fastify(); registerDeploymentRoutes(app, db, async () => {}); await app.ready();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM licence_history").get() as any).c, 1, "history survives the rebuild"); assert.equal((db.prepare("SELECT name FROM licence_deployments").get() as any).name, "Old");
  db.prepare("UPDATE licence_deployments SET type='FULL' WHERE id=1").run(); assert.equal((db.prepare("SELECT type FROM licence_deployments").get() as any).type, "FULL");
  registerDeploymentRoutes(Fastify(), db, async () => {});   // second start: nothing to rebuild
  await app.close();
});
test("source: the page says DATA SOURCES, not gateways; type selector with FREE / PRO / FULL; defaults today and one year; edit dialog can change type", () => {
  const pg = readFileSync("web/src/Licences.tsx", "utf8");
  assert.ok(!/Gateways? in use|Gateway limit|label="Gateways"|1 gateway|gateways, \d/i.test(pg), "no 'gateway' label left on screen"); assert.match(pg, /Data sources in use/); assert.match(pg, /label="Data sources"/); assert.match(pg, /data \$\{t\.gateways === 1 \? "source" : "sources"\}/);
  assert.match(pg, /\["FREE", "PRO", "FULL", "ENGINEERING"\]/, "ENGINEERING is the fourth selectable type"); assert.match(pg, /role="radiogroup"/); assert.match(pg, /no expiry by default/); assert.match(pg, /of \{lim\(limit\)\}/); assert.match(pg, /n === null \? "unlimited"/);
  assert.match(pg, /issuedAt: todayYmd\(\), validUntil: addYear\(todayYmd\(\)\)/); assert.match(pg, /NO EXPIRY/); assert.match(pg, /CHANGE TYPE/); assert.match(pg, /onChangeType=\{\(\) => setModal\("record"\)\}/);
  assert.ok(!/limitGateways|limitSensors|type="number"[^>]*gw/.test(pg.slice(pg.indexOf("function RecordForm"), pg.indexOf("const CONSEQUENCE"))), "limits are not typed in the issue dialog");
});

test("ENGINEERING: selectable in ISSUE and RENEW, unlimited, no expiry by default, usage never AT LIMIT / OVER LIMIT", async () => {
  const x = await rig({ online: true, now: () => NOW }); closers.push(() => void x.close()); const c = (m: string, u: string, b?: unknown) => x.call(x.admin, m, u, b);
  const id = (await c("POST", "/api/licence-deployments", { name: "Bench", deviceId: ID(31), usedGateways: 10, usedSensors: 100 })).json.deployment.id, rec = (b: object) => c("POST", `/api/licence-deployments/${id}/record`, b);
  assert.equal((await c("GET", `/api/licence-deployments/${id}`)).json.deployment.usageFlags.sensors, "over_limit", "FREE record: 100 sensors against 10");
  let r = await rec({ type: "ENGINEERING", licenceId: "FPL-20261118-0031", issuedAt: "2026-11-18" });          // ISSUE: no validUntil sent = no expiry
  assert.equal(r.status, 200); let d = r.json.deployment; assert.deepEqual(d.limits, { gateways: null, sensors: null, reports_days: null, retention_days: null }); assert.deepEqual([d.type, d.validUntil, d.status, d.daysLeft, d.termPct], ["ENGINEERING", null, "active", null, null]);
  assert.deepEqual(d.usageFlags, { gateways: "ok", sensors: "ok" }, "10 data sources and 100 sensors against unlimited: never AT LIMIT or OVER LIMIT"); assert.deepEqual([d.effectiveLimits.gateways, d.effectiveLimits.sensors], [null, null]);
  d = (await c("PATCH", `/api/licence-deployments/${id}`, { usedGateways: 100000, usedSensors: 100000 })).json.deployment; assert.deepEqual(d.usageFlags, { gateways: "ok", sensors: "ok" });
  assert.equal(((await c("GET", `/api/licence-deployments/${id}/history`)).json.history as any[])[0].note, "ENGINEERING, unlimited data sources, unlimited sensors, no expiry");
  assert.equal((await c("GET", "/api/licence-deployments/attention")).json.count, 0, "no expiry: not in the badge");
  assert.equal((await rec({ type: "ENGINEERING", licenceId: "FPL-20261118-0032", limitDataSources: 5 })).status, 400, "mismatched limits refused");
  r = await rec({ type: "PRO", licenceId: "FPL-20261118-0033", validUntil: "2027-11-18" }); assert.equal(r.json.deployment.usageFlags.sensors, "over_limit", "RENEW to PRO: bars follow the new type");
  r = await rec({ type: "ENGINEERING", licenceId: "FPL-20261118-0034" }); assert.equal(r.status, 200, "RENEW to ENGINEERING"); assert.equal(r.json.deployment.validUntil, null); assert.equal(r.json.deployment.usageFlags.sensors, "ok");
  assert.equal((await rec({ type: "FREE" })).status, 200);
});

test("Licence ID prefill: FPL-<issued date>-<next free number for that date>, follows the date, validation text for a Device ID", () => {
  assert.equal(nextLicenceId("2026-11-18", []), "FPL-20261118-0001"); assert.equal(nextLicenceId("2026-11-18", [null, "FPL-20261117-0005", "FPL-20261118-0001", "FPL-20261118-0007", "junk"]), "FPL-20261118-0008", "highest for THAT date + 1; other dates ignored");
  assert.equal(nextLicenceId("2026-11-17", ["FPL-20261117-0005", "FPL-20261118-0009"]), "FPL-20261117-0006", "changing the date changes the number"); assert.equal(nextLicenceId("2026-11-19", ["FPL-20261118-0009"]), "FPL-20261119-0001");
  assert.equal(nextLicenceId("", []), null); assert.equal(nextLicenceId("2026-02-31", []), null); assert.equal(nextLicenceId("2026-11-18", ["FPL-20261118-9999"]), null);
  assert.equal(licenceIdError("FPL-20261117-0001"), null); assert.match(licenceIdError("")!, /required/); assert.match(licenceIdError("FPL-2026-1")!, /Format FPL-YYYYMMDD-NNNN/);
  assert.equal(licenceIdError("FP-48F1-40C7-092D"), "That looks like a Device ID. The Device ID goes in Edit deployment; the Licence ID looks like FPL-20261117-0001."); assert.equal(licenceIdError("fp-48f1-40c7-092d"), DEVICE_ID_MSG);
  const pg = readFileSync("web/src/Licences.tsx", "utf8");
  assert.match(pg, /nextLicenceId\(todayYmd\(\), usedIds\)/, "prefilled"); assert.match(pg, /o\.idTouched \? o\.licenceId : nextLicenceId\(x, usedIds\)/, "follows the issued date until edited"); assert.match(pg, /onBlur=\{\(\) => setIdErr\(licenceIdError\(v\.licenceId\)\)\}/, "validated on blur");
  assert.match(pg, /LICENCE_ID_HELP/); assert.match(pg, /role="alert"/); assert.match(pg, /licenceIdError\(v\.licenceId\) !== null/, "RECORD stays disabled for an invalid value");
});
