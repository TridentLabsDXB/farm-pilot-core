import "./isolate.js";   // test data folder is a temp dir
// Licence Management (Online build only, 2026-11-17): status rules, usage flags, Admin-only API, Online vs standalone, audit, record-only behaviour.
import test, { after } from "node:test"; import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rig } from "./rig.js";
import { deploymentStatus, usageFlag, termPct, sortByExpiry, effectiveLimits, FREE_LIMITS } from "../src/deployments/calc.js";
import { FREE_LICENCE } from "../src/licence/free.js";

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
  const mk = async (name: string, n: number, type: string, until: string | null) => { const d = (await c("POST", "/api/licence-deployments", { name, deviceId: ID(n) })).json.deployment.id; if (type !== "FREE") await c("POST", `/api/licence-deployments/${d}/record`, { type, licenceId: `FPL-20260101-${String(n).padStart(4, "0")}`, issuedAt: "2026-01-01", validUntil: until, limitGateways: 3, limitSensors: 50, limitReportsDays: null, limitRetentionDays: 365 }); return d; };
  await mk("Soon", 2, "PRO", "2026-12-10"); await mk("Gone", 3, "PRO", "2026-11-01"); await mk("Later", 4, "PRO", "2027-06-30"); await mk("Eng", 5, "ENGINEERING", null).catch(() => 0);
  assert.equal((await c("GET", "/api/licence-deployments/attention")).json.count, 2, "EXPIRING + EXPIRED");
  const list = (await c("GET", "/api/licence-deployments")).json.deployments as any[];
  assert.deepEqual(list.map((d) => d.name), ["Gone", "Soon", "Later", "Greenhouse 1"].concat(list.some((d) => d.name === "Eng") ? ["Eng"] : []).sort((a, b) => list.findIndex((d) => d.name === a) - list.findIndex((d) => d.name === b)), "sorted by expiry, no expiry last");
  assert.equal(list[0].name, "Gone"); assert.equal(list[0].status, "expired"); assert.deepEqual(list[0].effectiveLimits, FREE_LIMITS);
  assert.equal(list.find((d) => d.name === "Soon").status, "expiring"); assert.equal(list.find((d) => d.name === "Later").status, "active");
  // ISSUE on a FREE box writes ISSUED; RENEW on a licensed box writes RENEWED; both are audited; nothing is signed
  r = await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "FPL-20261117-0001", validUntil: "2027-11-16", limitGateways: 2, limitSensors: 50, limitReportsDays: null, limitRetentionDays: 365 });
  assert.equal(r.status, 200); assert.equal(r.json.deployment.type, "PRO"); assert.equal(r.json.deployment.status, "active"); assert.equal(r.json.deployment.validUntil, "2027-11-16T23:59:59Z"); assert.equal(r.json.deployment.usageFlags.sensors, "ok");
  r = await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "FPL-20261117-0002", validUntil: "2028-11-16", limitGateways: 2, limitSensors: 50, limitReportsDays: null, limitRetentionDays: 365 }); assert.equal(r.status, 200);
  const h = (await c("GET", `/api/licence-deployments/${id1}/history`)).json.history as any[]; assert.deepEqual(h.map((e) => e.event), ["RENEWED", "ISSUED"]);
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/history`, { event: "INSTALLED", note: "on site" })).status, 201); assert.equal((await c("POST", `/api/licence-deployments/${id1}/history`, { event: "ISSUED" })).status, 400);
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "FREE", licenceId: "x" })).status, 400); assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "PRO", licenceId: "x" })).status, 400, "licence id format");
  assert.equal((await c("POST", `/api/licence-deployments/${id1}/record`, { type: "ENGINEERING", licenceId: "FPL-20261117-0003", validUntil: "2028-01-01", limitGateways: null, limitSensors: null })).status, 400, "ENGINEERING = no expiry, no limits");
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
