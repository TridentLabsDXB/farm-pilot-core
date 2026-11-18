import "./isolate.js";   // test data folder is a temp dir
// 2026-11-19 -- Connected Boxes in the Farm Profile time zone (display only). Server helper (src/fleet/time.ts, used by the CSV) and web helper (web/src/fleetTime.ts, used by the page) are run against the SAME cases.
import test, { after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";
import * as S from "../src/fleet/time.js"; import * as W from "../web/src/fleetTime.js"; import { rig } from "./rig.js";
const closers: (() => unknown)[] = []; after(() => closers.forEach((c) => c()));
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0), ID = "FP-48F1-40C7-092D";

test("Asia/Dubai: UTC+4 label and local time; UTC, unset and unknown zones fall back to UTC with the label UTC", () => {
  for (const m of [S, W] as const) {
    assert.equal(m.zoneLabel("Asia/Dubai", T0), "UTC+4"); assert.equal(m.zoneLabel("UTC", T0), "UTC"); assert.equal(m.zoneLabel(undefined, T0), "UTC"); assert.equal(m.zoneLabel("Mars/Base", T0), "UTC"); assert.equal(m.zoneLabel("", T0), "UTC");
    assert.equal(m.zoneLabel("Asia/Kolkata", T0), "UTC+5:30"); assert.equal(m.zoneLabel("America/Sao_Paulo", T0), "UTC-3"); assert.equal(m.zoneOf("Asia/Dubai"), "Asia/Dubai"); assert.equal(m.zoneOf(null), "UTC"); assert.equal(m.zoneOf("nonsense"), "UTC");
  }
  assert.equal(S.localStamp("Asia/Dubai", T0), "2026-11-19 14:00:00"); assert.equal(S.localStamp(undefined, T0), "2026-11-19 10:00:00"); assert.equal(S.localStamp("Asia/Dubai", T0, false), "2026-11-19 14:00");
  assert.equal(W.stamp("Asia/Dubai", T0), "2026-11-19 14:00 UTC+4"); assert.equal(W.stamp(undefined, T0), "2026-11-19 10:00 UTC"); assert.equal(W.dayStamp("Asia/Dubai", T0), "2026-11-19 (UTC+4)");
  assert.equal(W.stamp("Asia/Dubai", Date.UTC(2026, 10, 19, 20, 0, 0)), "2026-11-20 00:00 UTC+4", "20:00 UTC is midnight in Dubai: the NEXT day"); assert.equal(W.stamp("Asia/Dubai", Date.UTC(2026, 10, 19, 19, 59, 59)), "2026-11-19 23:59 UTC+4");
});

test("day boundary: UTC 20:00-23:59 belongs to the next Dubai day, 00:00-03:59 UTC is the same Dubai day as 04:00-19:59; the strip follows the zone", () => {
  const D = (h: number, d = 19) => Date.UTC(2026, 10, d, h);
  assert.equal(W.dayKey("Asia/Dubai", D(19)), "2026-11-19"); assert.equal(W.dayKey("Asia/Dubai", D(20)), "2026-11-20"); assert.equal(W.dayKey("Asia/Dubai", D(23)), "2026-11-20"); assert.equal(W.dayKey("Asia/Dubai", D(0, 20)), "2026-11-20"); assert.equal(W.dayKey("Asia/Dubai", D(3, 20)), "2026-11-20"); assert.equal(W.dayKey("Asia/Dubai", D(4, 20)), "2026-11-20"); assert.equal(W.dayKey("Asia/Dubai", D(20, 20)), "2026-11-21");
  assert.equal(W.dayKey(undefined, D(20)), "2026-11-19", "UTC fallback keeps the UTC day");
  const hours = [19, 20, 23].map((h) => ({ hour_ts: D(h), expected: 60, received: 60 })).concat([{ hour_ts: D(0, 20), expected: 60, received: 30 }]);
  const now = D(22);                                    // 02:00 on 20 Nov in Dubai
  const dub = W.groupDays("Asia/Dubai", hours, now), utc = W.groupDays("UTC", hours, now);
  assert.equal(dub.length, 30); assert.equal(dub.at(-1)!.key, "2026-11-20", "today in Dubai is the 20th"); assert.equal(utc.at(-1)!.key, "2026-11-19"); assert.equal(dub[0].key, "2026-10-22");
  assert.deepEqual([dub.at(-2)!.expected, dub.at(-2)!.received], [60, 60], "19 Nov Dubai = only the 19:00 UTC hour"); assert.deepEqual([dub.at(-1)!.expected, dub.at(-1)!.received], [180, 150], "20 Nov Dubai = 20:00, 23:00 and the next 00:00 UTC hour"); assert.equal(dub.at(-1)!.pct, 83.3);
  assert.deepEqual([utc.at(-1)!.expected, utc.at(-1)!.received], [180, 180], "UTC: 19:00, 20:00 and 23:00 are all the 19th"); assert.equal(utc.at(-1)!.pct, 100); assert.equal(dub[3].pct, null, "no data = null");
});

test("CSV: times in the Farm Profile zone (header names the zone) plus the same times in UTC; unknown zone falls back to UTC; the API stays UTC", async () => {
  const clock = { t: T0 }; const r = await rig({ online: true, now: () => clock.t }); closers.push(() => void r.close());
  const HTTPS = { "x-forwarded-proto": "https" }, code = (await r.call(r.admin, "POST", "/api/fleet/codes", {})).json.code;
  const en = await r.call(null, "POST", "/api/fleet/enrol", { device_id: ID, name: "BENCH", code }, HTTPS); const key = en.json.access_key;
  const rep = () => r.call(null, "POST", "/api/fleet/report", { v: 1, device_id: ID, box_name: "BENCH", interval_s: 60, version: "0.3.0", licence: { type: "PRO", valid_until: "2027-11-18", state: "LICENSED" }, usage: { data_sources: { n: 1, max: 5 }, sensors: { n: 2, max: 50 } } }, { ...HTTPS, "x-device-id": ID, authorization: "Bearer " + key });
  assert.equal((await rep()).status, 200);
  r.db.prepare("UPDATE farm_profile SET timezone='Asia/Dubai' WHERE id=1").run(); (await r.call(r.admin, "GET", "/api/farm-profile/public"));
  let csv = await r.call(r.admin, "GET", "/api/fleet/export.csv"); let [head, row] = csv.txt.trim().split("\r\n"); const cols = head.split(","), vals = row.split(",");
  const at = (n: string) => vals[cols.findIndex((c) => c.startsWith(n))];
  assert.ok(cols.includes("last_seen (Asia/Dubai UTC+4)") && cols.includes("first_enrolled (Asia/Dubai UTC+4)"), head); assert.ok(cols.includes("last_seen_utc") && cols.includes("first_enrolled_utc"), "UTC columns kept");
  assert.equal(at("last_seen ("), "2026-11-19 14:00:00"); assert.equal(at("last_seen_utc"), "2026-11-19T10:00:00.000Z"); assert.equal(at("first_enrolled ("), "2026-11-19 14:00:00"); assert.equal(at("first_enrolled_utc"), "2026-11-19T10:00:00.000Z");
  r.db.prepare("UPDATE farm_profile SET timezone='Not/AZone' WHERE id=1").run(); csv = await r.call(r.admin, "GET", "/api/fleet/export.csv"); [head, row] = csv.txt.trim().split("\r\n"); assert.ok(head.includes("last_seen (UTC)"), head); assert.ok(row.includes("2026-11-19 10:00:00,2026-11-19T10:00:00.000Z"));
  // API: still epoch ms / ISO UTC, plus the zone the page should use
  r.db.prepare("UPDATE farm_profile SET timezone='Asia/Dubai' WHERE id=1").run(); const l = (await r.call(r.admin, "GET", "/api/fleet/boxes")).json; assert.equal(l.tz, "Asia/Dubai"); assert.equal(l.boxes[0].last_report_at, T0); assert.equal(l.boxes[0].first_enrolled_at, T0);
  const h = (await r.call(r.admin, "GET", `/api/fleet/boxes/${l.boxes[0].id}/history`)).json; assert.equal(h.events[0].ts, T0); assert.ok(Array.isArray(h.hours) && h.hours[0].hour_ts % 3_600_000 === 0, "hourly records stay UTC hours"); assert.equal(h.days[0].day_ts % 86_400_000, 0, "the API day cells stay UTC days");
});

test("the page uses the helper everywhere a time is shown; no hard-coded zone; the 03:00 prune and hourly buckets are unchanged (UTC)", () => {
  const p = readFileSync("web/src/FleetPage.tsx", "utf8"), strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/toISOString\(\)\.slice|" UTC"|Asia\/Dubai|GST/.test(strip(p)), "no UTC formatting left and no hard-coded zone in the page");
  for (const w of ["dtstr(", "dstr(", "groupDays(fmtCfg.tz", "LAST REPORT"]) assert.ok(p.includes(w), w);
  assert.ok(!/Asia\/Dubai/.test(strip(readFileSync("src/fleet/time.ts", "utf8") + readFileSync("src/fleet/routes.ts", "utf8") + readFileSync("web/src/fleetTime.ts", "utf8"))), "no zone in the code");
  assert.match(readFileSync("src/fleet/service.ts", "utf8"), /getUTCHours\(\) < 3/, "prune still at 03:00 UTC"); assert.match(readFileSync("src/fleet/status.ts", "utf8"), /hourStart = \(ms: number\) => Math\.floor\(ms \/ HOUR\) \* HOUR/);
});
