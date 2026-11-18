import "./isolate.js";   // test data folder is a temp dir
// 2026-11-19 -- Connected Boxes, ONLINE side (core-server-connection-spec.md, "Tests"): HTTPS and 4 KB limits, code enrolment (valid / expired / reused), approval, key hash only, wrong key counted and not stored,
// 10 s rate limit, revoke, status rule for 1 / 5 / 15 minute intervals computed on SERVER time, 30-day history (events, hourly records, prune, latest report kept, survives revoke), CSV, roles, licence link.
import test, { after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";
import { rig } from "./rig.js"; import { boxStatus, clampInterval, lateAt, offlineAt, HOUR, DAY } from "../src/fleet/status.js"; import { sha256, parseReport } from "../src/fleet/service.js";

const closers: (() => unknown)[] = []; after(() => closers.forEach((c) => c()));
const ID = "FP-48F1-40C7-092D", ID2 = "FP-7A20-C913-55E1", T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const HTTPS = { "x-forwarded-proto": "https" };
async function online() { const clock = { t: T0 }; const r = await rig({ online: true, now: () => clock.t }); closers.push(() => void r.close());
  const enrol = (body: any, h: Record<string, string> = HTTPS) => r.call(null, "POST", "/api/fleet/enrol", body, h);
  const code = async () => (await r.call(r.admin, "POST", "/api/fleet/codes", { note: "x" })).json.code as string;
  const rep = (id: string, key: string, over: any = {}, h: Record<string, string> = {}) => r.call(null, "POST", "/api/fleet/report", { v: 1, device_id: id, box_name: "BENCH", report_no: 1, sent_at: "2020-01-01T00:00:00Z", interval_s: 60, version: "0.3.0", build: "f1e73e8", os: "Windows 10 Pro", runs_as: "service", uptime_s: 100,
    licence: { type: "PRO", valid_until: "2027-11-18", state: "LICENSED" }, usage: { data_sources: { n: 1, max: 5 }, sensors: { n: 16, max: 50 } }, last_data_at: new Date(clock.t - 60000).toISOString(), active_alarms: 2, ...over }, { ...HTTPS, "x-device-id": id, authorization: "Bearer " + key, ...h });
  const enrolled = async (id = ID, name = "BENCH") => { const e = await enrol({ device_id: id, name, code: await code() }); assert.equal(e.status, 200, e.txt); return e.json.access_key as string; };
  const list = async () => (await r.call(r.admin, "GET", "/api/fleet/boxes")).json;
  return { r, clock, enrol, code, rep, enrolled, list }; }

test("status rule: ONLINE under 3 intervals, LATE up to 15 minutes more, then OFFLINE; NOT ENROLLED before the first report; for 1, 5 and 15 minute boxes", () => {
  for (const iv of [60, 300, 900]) {
    const three = 3 * iv * 1000, late = three + 15 * 60_000, last = T0;
    assert.equal(boxStatus(last, iv, last), "ONLINE"); assert.equal(boxStatus(last, iv, last + three - 1), "ONLINE"); assert.equal(boxStatus(last, iv, last + three), "LATE");
    assert.equal(boxStatus(last, iv, last + late - 1), "LATE"); assert.equal(boxStatus(last, iv, last + late), "OFFLINE"); assert.equal(boxStatus(last, iv, last + 30 * DAY), "OFFLINE");
    assert.equal(lateAt(last, iv), last + three); assert.equal(offlineAt(last, iv), last + late);
  }
  assert.equal(boxStatus(null, 60, T0), "NOT_ENROLLED"); assert.equal(clampInterval(60), 60); assert.equal(clampInterval(290), 300); assert.equal(clampInterval(5000), 900); assert.equal(clampInterval("x"), 60); assert.equal(clampInterval(10), 60);
});

test("standalone build has no Connected Boxes routes; Online build exposes them and /api/me says online", async () => {
  const off = await rig({ online: false }); closers.push(() => void off.close());
  for (const [m, u] of [["POST", "/api/fleet/enrol"], ["POST", "/api/fleet/report"], ["GET", "/api/fleet/boxes"], ["POST", "/api/fleet/codes"], ["GET", "/api/fleet/export.csv"]] as const) assert.equal((await off.call(off.admin, m, u, m === "POST" ? {} : undefined, HTTPS)).status, 404, `${m} ${u}`);
  assert.equal((await off.call(null, "POST", "/api/fleet/report", {}, HTTPS)).status, 401, "unknown routes still need a login on a standalone box");
  const { r } = await online(); assert.equal((await r.call(r.admin, "GET", "/api/me")).json.online, true); assert.equal((await r.call(r.admin, "GET", "/api/fleet/boxes")).status, 200);
});

test("plain HTTP is rejected, bodies over 4 KB are rejected, Device ID must match", async () => {
  const { enrol, rep, enrolled } = await online(); const key = await enrolled();
  assert.equal((await enrol({ device_id: ID }, {})).status, 400); assert.equal((await rep(ID, key, {}, { "x-forwarded-proto": "http" })).status, 400, "http via the proxy");
  assert.equal((await rep(ID, key, { box_name: "x".repeat(5000) })).status, 413); assert.equal((await enrol({ device_id: ID, name: "x".repeat(5000) })).status, 413);
  assert.equal((await rep(ID, key, { device_id: ID2 })).status, 400, "body and header differ"); assert.equal((await rep(ID, key, { v: 2 })).status, 400); assert.equal((await rep("nonsense", key)).status, 400);
  assert.equal((await rep(ID, key)).status, 200, "and a good one still works");
});

test("code enrolment: valid once, reused and expired are refused the same way; the key is stored as a hash only", async () => {
  const { r, clock, enrol, code, enrolled } = await online(); const c1 = await code(); assert.match(c1, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const e = await enrol({ device_id: ID, name: "BENCH", version: "0.3.0", code: c1.toLowerCase() }); assert.equal(e.status, 200); assert.equal(e.json.status, "approved"); const key = e.json.access_key as string; assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  const row = r.db.prepare("SELECT * FROM fleet_boxes WHERE device_id=?").get(ID) as any; assert.equal(row.key_hash, sha256(key)); assert.equal(row.state, "approved"); assert.equal(row.first_enrolled_at, T0);
  const dump = JSON.stringify(["fleet_boxes", "fleet_codes", "fleet_events", "fleet_hours", "audit_log", "settings"].map((t) => r.db.prepare(`SELECT * FROM ${t}`).all())); assert.ok(!dump.includes(key), "the plain key is nowhere in the database");
  assert.ok(!dump.includes(c1.replace("-", "")), "nor the plain code (hash and a 3-character hint only)");
  const again = await enrol({ device_id: ID2, code: c1 }); assert.equal(again.status, 403); assert.equal(again.json.error, "enrolment code not valid or expired");
  const c2 = await code(); clock.t += 24 * HOUR - 1; assert.equal((await enrol({ device_id: ID2, code: c2 })).status, 200, "valid for 24 h"); const c3 = await code(); clock.t += 24 * HOUR + 1; const exp = await enrol({ device_id: "FP-B3D4-0E7A-1C28", code: c3 }); assert.equal(exp.status, 403); assert.equal(exp.json.error, again.json.error);
  assert.equal((await enrol({ device_id: ID2, code: "ZZZZ-ZZZZ" })).status, 403, "unknown code");
  const listed = (await r.call(r.admin, "GET", "/api/fleet/boxes")).json; assert.equal(listed.codes.length, 0, "used and expired codes are not offered again"); assert.ok(!JSON.stringify(listed).includes(key)); assert.ok(!JSON.stringify(listed).includes(sha256(key)), "the hash is not sent to the page either");
  const k2 = await enrolled(ID); assert.notEqual(k2, key, "enrolling again replaces the key");
});

test("a re-enrolled box: the old key stops working at once", async () => {
  const { rep, enrolled, clock } = await online(); const k1 = await enrolled(); assert.equal((await rep(ID, k1)).status, 200); clock.t += 11_000; const k2 = await enrolled();
  assert.equal((await rep(ID, k1)).status, 401); assert.equal((await rep(ID, k2)).status, 200);
});

test("approval flow: no code = WAITING FOR APPROVAL, the box asks again, approve gives it a key once; reject keeps it out; audit on both sides", async () => {
  const { r, enrol, rep, list } = await online();
  let e = await enrol({ device_id: ID, name: "NEW BOX", version: "0.3.0" }); assert.equal(e.status, 202); assert.equal(e.json.access_key, undefined); assert.equal((await enrol({ device_id: ID, name: "NEW BOX" })).status, 202, "asking again changes nothing");
  let l = await list(); assert.equal(l.kpi.waiting, 1); assert.equal(l.waiting[0].device_id, ID); assert.equal(l.waiting[0].name, "NEW BOX"); assert.equal(l.boxes.length, 0); assert.equal((await rep(ID, "x".repeat(43))).status, 401, "no key, no report");
  const id = l.waiting[0].id; assert.equal((await r.call(r.admin, "POST", `/api/fleet/boxes/${id}/approve`)).status, 200); assert.equal((await r.call(r.admin, "POST", `/api/fleet/boxes/${id}/approve`)).status, 400, "only once");
  assert.equal((await list()).boxes[0].status, "NOT_ENROLLED", "approved but no report yet");
  e = await enrol({ device_id: ID, name: "NEW BOX" }); assert.equal(e.status, 200); const key = e.json.access_key; assert.ok(key); assert.equal((await rep(ID, key)).status, 200);
  assert.equal((await enrol({ device_id: ID })).status, 409, "a second key is never handed out without a code");
  e = await enrol({ device_id: ID2, name: "BAD BOX" }); l = await list(); const id2 = l.waiting[0].id; assert.equal((await r.call(r.admin, "POST", `/api/fleet/boxes/${id2}/reject`)).status, 200);
  e = await enrol({ device_id: ID2 }); assert.equal(e.status, 403); assert.equal(e.json.status, "rejected"); assert.equal((await list()).kpi.waiting, 0);
  const acts = (r.db.prepare("SELECT username,action FROM audit_log WHERE action LIKE 'fleet.%' ORDER BY id").all() as { username: string; action: string }[]);
  assert.ok(acts.some((a) => a.action === "fleet.enrol_requested" && a.username === "box:" + ID), "box side"); assert.ok(acts.some((a) => a.action === "fleet.approve" && a.username === "admin"), "admin side"); assert.ok(acts.some((a) => a.action === "fleet.reject"));
  assert.ok(acts.some((a) => a.action === "fleet.enrol" && a.username === "box:" + ID));
});

test("report: stored as the latest only (sanitised field by field); wrong key = 401, counted, not stored; unknown box = 401; 1 report per 10 s", async () => {
  const { r, clock, rep, enrolled, list } = await online(); const key = await enrolled();
  assert.equal((await rep(ID, "A".repeat(43))).status, 401); assert.equal((await rep(ID, "A".repeat(43), { box_name: "EVIL" })).status, 401); assert.equal((await rep(ID2, key)).status, 401, "unknown Device ID looks the same");
  let row = r.db.prepare("SELECT * FROM fleet_boxes WHERE device_id=?").get(ID) as any; assert.equal(row.auth_failures, 2); assert.equal(row.report_count, 0); assert.equal(row.last_report, null, "nothing from a failed report is stored"); assert.equal(row.last_auth_failure_at, T0);
  assert.equal(r.db.prepare("SELECT COUNT(*) c FROM fleet_boxes WHERE device_id=?").get(ID2).c, 0, "an unknown box is not created by a bad report");
  const ok = await rep(ID, key, { report_no: 7, evil: "<script>", readings: [1, 2], users: ["a"], password: "p" }); assert.equal(ok.status, 200); assert.equal(ok.json.ok, true); assert.equal(ok.json.server_time, new Date(T0).toISOString()); assert.equal(ok.json.next_in_s, 60);
  row = r.db.prepare("SELECT * FROM fleet_boxes WHERE device_id=?").get(ID) as any; const stored = JSON.parse(row.last_report); assert.equal(row.last_report_at, T0, "SERVER time, not the box's sent_at (2020)"); assert.equal(stored.report_no, 7);
  assert.ok(!/evil|script|readings|users|password|sent_at|device_id/.test(row.last_report), "unknown fields are ignored, not stored");
  const r2 = await rep(ID, key); assert.equal(r2.status, 429); assert.equal(r2.headers.get("retry-after"), "10"); assert.equal((r.db.prepare("SELECT report_count c FROM fleet_boxes WHERE device_id=?").get(ID) as any).c, 1, "the refused report is not stored");
  clock.t += 9_999; assert.equal((await rep(ID, key)).status, 429); clock.t += 1; assert.equal((await rep(ID, key, { report_no: 8 })).status, 200);
  assert.equal(parseReport({ v: 1, interval_s: 777, licence: { state: "HACKED" } }).licence.state, "FREE"); assert.equal(parseReport({ v: 1, usage: { sensors: { n: -5, max: null } } }).usage.sensors.max, null);
  const b = (await list()).boxes[0]; assert.equal(b.last_seen_s, 0); assert.equal(b.auth_failures, 2); assert.ok(!("key_hash" in b));
});

test("the rate limit is per Device ID: a flood from one box does not touch another; failed keys from one address are throttled", async () => {
  const { r, clock, rep, enrolled, enrol, code } = await online(); const k1 = await enrolled(ID), k2 = await enrolled(ID2);
  assert.equal((await rep(ID, k1)).status, 200); assert.equal((await rep(ID, k1)).status, 429); assert.equal((await rep(ID2, k2)).status, 200, "other box unaffected");
  clock.t += 20_000; for (let i = 0; i < 30; i++) await rep(ID, "B".repeat(43)); const blocked = await rep(ID, k1); assert.equal(blocked.status, 429, "30 failures a minute from one address: throttled, even for a correct key");
  clock.t += 61_000; assert.equal((await rep(ID, k1)).status, 200); const c = await code(); for (let i = 0; i < 30; i++) await enrol({ device_id: ID2, code: "NOPE-NOPE" }); assert.equal((await enrol({ device_id: "FP-B3D4-0E7A-1C28", code: c })).status, 429, "code guessing is throttled too");
});

test("revoke: the next report fails with 401, the box row and its history stay, the admin can see REVOKED; re-enrolment with a new code works", async () => {
  const { r, clock, rep, enrolled, enrol, code, list } = await online(); const key = await enrolled(); await rep(ID, key); const id = (await list()).boxes[0].id;
  clock.t += 30_000; assert.equal((await r.call(r.admin, "POST", `/api/fleet/boxes/${id}/revoke`)).status, 200); clock.t += 30_000;
  const x = await rep(ID, key); assert.equal(x.status, 401); let l = await list(); assert.equal(l.boxes[0].status, "REVOKED"); assert.equal(l.kpi.boxes, 0, "revoked boxes are not counted as live"); assert.equal(r.db.prepare("SELECT key_hash k FROM fleet_boxes").get().k, null);
  const h = (await r.call(r.admin, "GET", `/api/fleet/boxes/${id}/history`)).json; assert.ok(h.events.some((e: any) => e.status === "REVOKED") && h.events.some((e: any) => e.status === "ONLINE"), "history survives the revoke"); assert.equal((await r.call(r.admin, "POST", `/api/fleet/boxes/${id}/revoke`)).status, 400);
  assert.equal((await enrol({ device_id: ID })).status, 409, "no code, no new key"); const k2 = await enrol({ device_id: ID, code: await code() }); assert.equal(k2.status, 200); clock.t += 60_000; assert.equal((await rep(ID, k2.json.access_key)).status, 200); l = await list(); assert.equal(l.boxes[0].status, "ONLINE");
  assert.ok((r.db.prepare("SELECT action FROM audit_log WHERE action='fleet.revoke'").all() as any[]).length === 1);
});

test("history: status-change events at their exact moments, hourly records, percent online, a 30-day strip; the latest report is kept", async () => {
  const { r, clock, rep, enrolled, list } = await online(); const key = await enrolled(); const svc = (r as any); const id = (async () => (await list()).boxes[0]?.id)();
  // one hour of reports every 60 s -> ONLINE, ~100 %
  for (let i = 0; i < 60; i++) { assert.equal((await rep(ID, key)).status, 200); clock.t += 60_000; }
  clock.t -= 60_000; const last = clock.t; const bid = (await list()).boxes[0].id; const h1 = (await r.call(r.admin, "GET", `/api/fleet/boxes/${bid}/history`)).json;
  assert.equal(h1.days.length, 30); assert.equal(h1.events.length, 1); assert.equal(h1.events[0].status, "ONLINE"); assert.ok(h1.percent_online_30d >= 95, `percent ${h1.percent_online_30d}`);
  assert.equal(r.db.prepare("SELECT received r FROM fleet_hours WHERE device_id=? AND hour_ts=?").get(ID, T0).r, 60);
  // silence: tick marks LATE at last+3 min, OFFLINE at last+3+15 min, at those exact times
  const fs = await import("../src/fleet/service.js"); const s2 = new fs.FleetService(r.db, () => clock.t); clock.t = last + 2 * 60_000; s2.tick(); assert.equal((await list()).boxes[0].status, "ONLINE");
  clock.t = last + 3 * 60_000 + 5000; s2.tick(); assert.equal((await list()).boxes[0].status, "LATE"); clock.t = last + 18 * 60_000 + 5000; s2.tick(); assert.equal((await list()).boxes[0].status, "OFFLINE"); s2.tick();
  let ev = (r.db.prepare("SELECT ts,status FROM fleet_events WHERE device_id=? ORDER BY id").all(ID) as { ts: number; status: string }[]); assert.deepEqual(ev.map((e) => e.status), ["ONLINE", "LATE", "OFFLINE"], "no duplicates from repeated ticks"); assert.equal(ev[1].ts, last + 180_000); assert.equal(ev[2].ts, last + 18 * 60_000);
  clock.t = last + 2 * HOUR; assert.equal((await rep(ID, key)).status, 200); ev = r.db.prepare("SELECT ts,status FROM fleet_events WHERE device_id=? ORDER BY id").all(ID) as any; assert.equal(ev.at(-1)!.status, "ONLINE"); assert.equal(ev.at(-1)!.ts, clock.t, "back online recorded");
  const h2 = (await r.call(r.admin, "GET", `/api/fleet/boxes/${bid}/history`)).json; assert.ok(h2.percent_online_30d < h1.percent_online_30d, "the silent hour lowered it"); assert.ok(h2.percent_online_30d > 20 && h2.percent_online_30d < 80, String(h2.percent_online_30d));
  const today = h2.days.at(-1); assert.ok(today.expected > 0 && today.received > 0 && today.pct !== null); assert.equal(h2.days[0].pct, null, "no data before enrolment"); void svc; void id;
  assert.ok(r.db.prepare("SELECT last_report FROM fleet_boxes").get().last_report, "latest report kept"); assert.equal((r.db.prepare("SELECT COUNT(*) c FROM fleet_boxes").get() as any).c, 1);
});

test("nightly prune: events and hourly records older than 30 days go, newer ones and the latest report stay; once per day; survives a revoke until then", async () => {
  const { r, clock, rep, enrolled, list } = await online(); const key = await enrolled(); await rep(ID, key); const bid = (await list()).boxes[0].id; await r.call(r.admin, "POST", `/api/fleet/boxes/${bid}/revoke`);
  const fs = await import("../src/fleet/service.js"); const s = new fs.FleetService(r.db, () => clock.t);
  const old = T0 - 31 * DAY, edge = T0 - 29 * DAY; for (const ts of [old, edge]) { r.db.prepare("INSERT INTO fleet_events(device_id,ts,status) VALUES(?,?,'OFFLINE')").run(ID, ts); r.db.prepare("INSERT INTO fleet_hours(device_id,hour_ts,expected,received) VALUES(?,?,60,50)").run(ID, ts - (ts % HOUR)); }
  const cOld = await code2(r), n = s.prune(T0); assert.equal(n.events, 1); assert.equal(n.hours, 1); void cOld;
  assert.equal((r.db.prepare("SELECT COUNT(*) c FROM fleet_events WHERE ts=?").get(edge) as any).c, 1, "29 days old stays"); assert.equal((r.db.prepare("SELECT COUNT(*) c FROM fleet_events WHERE ts=?").get(old) as any).c, 0);
  const keep = r.db.prepare("SELECT COUNT(*) c FROM fleet_events WHERE status IN ('ONLINE','REVOKED')").get() as any; assert.equal(keep.c, 2, "this week's events and the revoke survive"); assert.ok(r.db.prepare("SELECT last_report FROM fleet_boxes").get().last_report, "latest report kept");
  // later: 31 days after the revoke the history is gone, the box row (and its latest report) is not
  clock.t = T0 + 31 * DAY; const m = s.prune(); assert.ok(m.events >= 2); assert.equal((r.db.prepare("SELECT COUNT(*) c FROM fleet_events").get() as any).c, 0); assert.equal((r.db.prepare("SELECT COUNT(*) c FROM fleet_boxes").get() as any).c, 1);
  // maybePrune: once per UTC day, not before 03:00
  const d = Date.UTC(2026, 11, 25); assert.equal(s.maybePrune(d + 2 * HOUR), null); assert.ok(s.maybePrune(d + 3 * HOUR)); assert.equal(s.maybePrune(d + 5 * HOUR), null); assert.ok(s.maybePrune(d + DAY + 4 * HOUR));
  assert.match(readFileSync("src/fleet/routes.ts", "utf8"), /svc\.tick\(\); svc\.maybePrune\(\)/, "the app runs both on a timer");
});
async function code2(r: any) { return (await r.call(r.admin, "POST", "/api/fleet/codes", {})).json.code; }

test("list view: KPI row, licence chip data with days left, SOURCES / SENSORS, filters data, FREE flagged, last seen, ADD BOX codes shown as NOT ENROLLED rows", async () => {
  const { r, clock, rep, enrolled, list, code } = await online(); const k1 = await enrolled(ID, "ALPHA"), k2 = await enrolled(ID2, "bravo"); const k3 = await enrolled("FP-91AC-6F02-D4B7", "CHARLIE");
  await rep(ID, k1, { box_name: "ALPHA" }); await rep(ID2, k2, { box_name: "bravo", licence: { type: "FREE", valid_until: null, state: "FREE" }, usage: { data_sources: { n: 1, max: 1 }, sensors: { n: 10, max: 10 } } });
  await rep("FP-91AC-6F02-D4B7", k3, { box_name: "CHARLIE", licence: { type: "PRO", valid_until: new Date(T0 + 12 * DAY).toISOString(), state: "LICENSED" }, usage: { data_sources: { n: 2, max: null }, sensors: { n: 3, max: null } } }); await code();
  clock.t += 5 * 60_000; await rep(ID, k1, { box_name: "ALPHA" }); let l = await list();
  assert.deepEqual(l.kpi, { boxes: 3, online: 1, late: 2, offline: 0, waiting: 0 }); assert.deepEqual(l.boxes.map((b: any) => b.name), ["ALPHA", "bravo", "CHARLIE"], "sorted by name, case-insensitive"); assert.equal(l.codes.length, 1); assert.match(l.codes[0].hint, /^[A-Z2-9]{3}$/); assert.ok(l.codes[0].expires_at > clock.t);
  const [a, b, c] = l.boxes; assert.equal(a.licence.type, "PRO"); assert.equal(a.licence.expiring, false); assert.deepEqual(a.sources, { n: 1, max: 5 }); assert.equal(b.licence.type, "FREE"); assert.equal(c.licence.days_left, 12); assert.equal(c.licence.expiring, true); assert.equal(c.sources.max, null, "unlimited");
  assert.equal(a.os, "Windows 10 Pro"); assert.equal(a.runs_as, "service"); assert.equal(a.active_alarms, 2); assert.equal(a.version, "0.3.0"); assert.equal(b.status, "LATE"); clock.t += 20 * 60_000; l = await list(); assert.equal(l.kpi.offline, 3); assert.equal(l.boxes[0].status, "OFFLINE");
  assert.ok(!JSON.stringify(l).includes(k1)); const one = await r.call(r.admin, "GET", `/api/fleet/boxes/${a.id}`); assert.equal(one.json.box.device_id, ID); assert.equal((await r.call(r.admin, "GET", "/api/fleet/boxes/9999")).status, 404);
  assert.equal((await r.call(r.admin, "PATCH", `/api/fleet/boxes/${a.id}`, { name: "  Renamed  " })).status, 200); assert.equal((await list()).boxes.find((x: any) => x.id === a.id).name, "Renamed"); assert.equal((await r.call(r.admin, "PATCH", `/api/fleet/boxes/${a.id}`, { name: " " })).status, 400);
  await rep(ID, k1, { box_name: "FROM THE BOX" }); assert.equal((await list()).boxes.find((x: any) => x.id === a.id).name, "Renamed", "an Admin's name is not overwritten by the box");
});

test("link to Licence Management by Device ID: known when a deployment exists, unknown otherwise; nothing is issued or changed from this page", async () => {
  const { r, rep, enrolled, list } = await online(); const k = await enrolled(ID); await enrolled(ID2); await rep(ID, k);
  const before = JSON.stringify(r.db.prepare("SELECT * FROM licence_deployments").all()); let l = await list(); assert.deepEqual(l.boxes.map((b: any) => b.licence_known), [false, false]);
  assert.equal((await r.call(r.admin, "POST", "/api/licence-deployments", { deviceId: ID, name: "Bench" })).status, 201); l = await list(); assert.equal(l.boxes.find((b: any) => b.device_id === ID).licence_known, true); assert.equal(l.boxes.find((b: any) => b.device_id === ID2).licence_known, false);
  const src = readFileSync("web/src/FleetPage.tsx", "utf8"); assert.match(src, /licence_known/); assert.match(src, /ADD TO LICENCE MANAGEMENT/); assert.match(src, /\/licences\?/); assert.ok(!/\/licence-deployments/.test(src), "the page never calls a licence-issuing route");
  assert.equal(before === JSON.stringify(r.db.prepare("SELECT * FROM licence_deployments").all()), false, "(only the deployment this test added changed)");
});

test("CSV export: Admin only, defuses spreadsheet formulas in box names, one row per box, audited", async () => {
  const { r, rep, enrolled } = await online(); const k = await enrolled(ID, "=HYPERLINK(\"http://x\")"); const k2 = await enrolled(ID2, "Plain, with comma"); await rep(ID, k, { box_name: "=HYPERLINK(\"http://x\")" }); await rep(ID2, k2, { box_name: "Plain, with comma" });
  const x = await r.call(r.admin, "GET", "/api/fleet/export.csv"); assert.equal(x.status, 200); assert.match(x.headers.get("content-type")!, /text\/csv/); assert.match(x.headers.get("content-disposition")!, /connected-boxes-2026-11-19\.csv/);
  const lines = x.txt.trim().split("\r\n"); assert.equal(lines.length, 3); assert.match(lines[0], /^status,name,device_id,licence,/); assert.ok(x.txt.includes("'=HYPERLINK"), "formula defused"); assert.ok(!/(^|,)=HYPERLINK/.test(x.txt)); assert.ok(x.txt.includes('"Plain, with comma"'));
  assert.equal((await r.call(r.op, "GET", "/api/fleet/export.csv")).status, 403); assert.ok(r.db.prepare("SELECT 1 FROM audit_log WHERE action='fleet.export_csv'").get());
});

test("roles: an Operator gets 403 on every admin route; the two box routes need no login but need a valid key; nothing sends anything to a box", async () => {
  const { r, enrolled } = await online(); await enrolled(); const id = (await r.call(r.admin, "GET", "/api/fleet/boxes")).json.boxes[0].id;
  for (const [m, u, b] of [["GET", "/api/fleet/boxes"], ["GET", `/api/fleet/boxes/${id}`], ["GET", `/api/fleet/boxes/${id}/history`], ["POST", `/api/fleet/boxes/${id}/approve`, {}], ["POST", `/api/fleet/boxes/${id}/reject`, {}], ["POST", `/api/fleet/boxes/${id}/revoke`, {}], ["PATCH", `/api/fleet/boxes/${id}`, { name: "x" }], ["POST", "/api/fleet/codes", {}], ["GET", "/api/fleet/export.csv"]] as const) {
    assert.equal((await r.call(r.op, m, u, b as any)).status, 403, `${m} ${u} as Operator`); assert.equal((await r.call(null, m, u, b as any)).status, 401, `${m} ${u} without login`); }
  const routes = r.routes.filter((x) => x.url.startsWith("/api/fleet")).map((x) => x.method + " " + x.url); assert.equal(routes.filter((x) => /^(POST|PUT|PATCH|DELETE) /.test(x)).length, 7, routes.join(", "));
  const src = readFileSync("src/fleet/service.ts", "utf8") + readFileSync("src/fleet/routes.ts", "utf8"); assert.ok(!/fetch\(|http\.request|https\.request|net\.connect|mqtt|WebSocket\(/.test(src.replace(/\/\/.*$/gm, "")), "the server side never connects to a box");
});

test("menu: Connected Boxes is in SYSTEM after Licence Management, Online + Admin only (sidebar and phone MORE sheet), route #/fleet", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8");
  assert.match(sb, /g\.title === "System" && online && <button[^\n]*go\("\/fleet"\)[^\n]*CONNECTED BOXES/); assert.ok(sb.indexOf("LICENCE MANAGEMENT") < sb.indexOf("CONNECTED BOXES"), "after Licence Management");
  assert.match(ab, /CONNECTED BOXES/); assert.ok(ab.indexOf("LICENCE MANAGEMENT") < ab.indexOf("CONNECTED BOXES")); assert.match(app, /page === "fleet" && admin && me\.online \? "fleet"/); assert.match(app, /page === "fleet"\) go\("\/monitoring"\)/, "standalone or Operator: back to MONITORING");
  assert.match(app, /cur === "fleet" \? <FleetPage/);
});
