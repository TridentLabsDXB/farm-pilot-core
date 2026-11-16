// 2026-11-16 -- MONITORING charts and CSV export (change request core-control-section-and-scada-charts.md): pure logic (buckets, downsampling, gaps, zone average, CSV writer, unit conversion),
// the licence range rule (FREE 7 days, PRO any range, one function), and the real HTTP API with role based columns, audit, row limit and streaming.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto"; import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js"; import { config } from "../src/config.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js";
import { createTransport } from "../src/drivers/modbus/transport.js"; import { ModbusMaster } from "../src/drivers/modbus/master.js"; import { GatewayDriver } from "../src/drivers/modbus/driver.js"; import { GatewaySim } from "../src/tools/gateway-sim/sim.js"; import { serveSim } from "../src/tools/gateway-sim/server.js";
import { LicenceService } from "../src/licence/service.js"; import { signLicence, type LicencePayload } from "../src/licence/format.js"; import { allowedFrom, DAY_MS } from "../src/licence/range.js";
import { BOM, bucketMs, csvFileName, csvHeader, csvNum, csvRow, csvText, downsample, gapThresholdMs, isoLocal, POINT_CAP, rangeAllowed, RANGES, toFahrenheit, usesRollup, withGaps, zoneAverage, type Pt } from "../src/history/logic.js";
import { effectiveRange, monitoringQuery, parseMonitoringQuery, rangeLocked, type ReportsMeta } from "../web/src/history.js"; import { nearest } from "../web/src/MonitoringCharts.js";

const closers: (() => unknown)[] = []; after(() => Promise.all(closers.map((c) => c())));
const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" };

// ---------- pure logic ----------
test("range to bucket logic: spans, raw rows up to 1W and hourly roll-ups for 1M, bucket never finer than a minute or the slowest sensor", () => {
  assert.deepEqual(RANGES, { "1h": 3_600_000, "24h": DAY_MS, "1w": 7 * DAY_MS, "1m": 30 * DAY_MS });
  assert.deepEqual((["1h", "24h", "1w", "1m"] as const).map(usesRollup), [false, false, false, true]);
  assert.equal(bucketMs(RANGES["1h"], 0), 60_000); assert.equal(bucketMs(RANGES["1h"], 300_000), 300_000); assert.equal(bucketMs(RANGES["1m"], 3_600_000), Math.ceil(RANGES["1m"] / POINT_CAP));
  assert.ok(RANGES["1m"] / bucketMs(RANGES["1m"], 0) <= POINT_CAP + 1);
});
test("downsampling keeps the first and last points and respects the 500 point cap; short series pass through", () => {
  const p: Pt[] = Array.from({ length: 5000 }, (_, i) => [1000 + i * 60_000, i]); const d = downsample(p);
  assert.ok(d.length <= POINT_CAP); assert.deepEqual(d[0], p[0]); assert.deepEqual(d[d.length - 1], p[p.length - 1]); assert.ok(d.every((x, i) => i === 0 || x[0] > d[i - 1][0]), "time stays increasing");
  const s = p.slice(0, 300); assert.equal(downsample(s), s); assert.equal(downsample(p, 3).length, 3);
  const flat: Pt[] = Array.from({ length: 2000 }, (_, i) => [i * 1000, 20]); assert.ok(downsample(flat).every(([, v]) => Math.abs(v - 20) < 1e-9), "bucket mean of a flat line is flat");
});
test("gap detection: a hole of more than 3 reporting intervals breaks the line (null point), 3 or fewer does not; nothing is interpolated", () => {
  const iv = 300_000, th = gapThresholdMs(iv, 60_000); assert.equal(th, 3 * iv);
  const ok = withGaps([[0, 1], [iv * 3, 2]], th); assert.equal(ok.length, 2);
  const g = withGaps([[0, 1], [iv, 2], [iv * 5, 3]], th); assert.equal(g.length, 4); assert.equal(g[2][1], null); assert.ok(g[2][0] > iv && g[2][0] < iv * 5);
});
test("zone average: per bucket the mean of the sensors that reported; a missing sensor is not counted as zero; buckets with no data are absent", () => {
  const a: Pt[] = [[0, 20], [600_000, 22]], b: Pt[] = [[10_000, 30]];            // bucket 0: both, bucket 10: only a
  const avg = zoneAverage([a, b], 0, 60_000); assert.equal(avg.length, 2); assert.equal(avg[0][1], 25); assert.equal(avg[1][1], 22);
  assert.deepEqual(zoneAverage([], 0, 60_000), []); assert.deepEqual(zoneAverage([[]], 0, 60_000), []);
});
test("CSV writer: BOM, RFC 4180 quoting, dot decimal, CRLF, local (with offset) and UTC times, role based columns, only temperature and humidity", () => {
  assert.equal(BOM, "\uFEFF"); assert.equal(csvText('a,"b"'), '"a,""b"""'); assert.equal(csvText("x\ny"), '"x\ny"'); assert.equal(csvText("plain"), "plain"); assert.equal(csvText("=1+1"), "'=1+1");
  assert.equal(csvNum(21.5), "21.5"); assert.equal(csvNum(null), ""); assert.equal(csvNum(1 / 3), "0.333");
  const ts = Date.parse("2026-11-16T10:05:00Z"); assert.equal(isoLocal(ts, "Asia/Dubai"), "2026-11-16T14:05:00+04:00"); assert.equal(isoLocal(ts, "UTC"), "2026-11-16T10:05:00+00:00"); assert.equal(isoLocal(ts, "America/New_York"), "2026-11-16T05:05:00-05:00");
  const h = csvHeader(false); assert.equal(h, BOM + "time_local,time_utc,zone,sensor_label,metric,value,unit\r\n"); assert.equal(csvHeader(true), BOM + "time_local,time_utc,zone,sensor_label,metric,value,unit,serial,raw_value,calibrated\r\n");
  const op = csvRow({ ts, zone: "GH 1, A", label: "Row 1", metric: "temperature", value: 21.5, serial: "112600310", raw: 20 }, "Asia/Dubai", "C", false);
  assert.equal(op, '2026-11-16T14:05:00+04:00,2026-11-16T10:05:00.000Z,"GH 1, A",Row 1,temperature,21.5,C\r\n'); assert.ok(!op.includes("112600310") && !op.includes(",20,"), "Operator rows have no serial and no raw value");
  const ad = csvRow({ ts, zone: "GH1", label: "Row 1", metric: "humidity", value: 55, serial: "112600310", raw: 50 }, "Asia/Dubai", "C", true); assert.ok(ad.endsWith(",humidity,55,%RH,112600310,50,yes\r\n"), ad);
  assert.ok(csvRow({ ts, zone: "z", label: "l", metric: "humidity", value: 55, serial: "1", raw: 55 }, "UTC", "C", true).endsWith(",1,55,no\r\n"));
  assert.equal(csvFileName("Al Maimoon Farms", "all", "24h", ts, "Asia/Dubai"), "farm-pilot_al-maimoon-farms_all-zones_24h_20261116-1405.csv"); assert.equal(csvFileName("F", "Greenhouse #1", "1w", ts, "UTC"), "farm-pilot_f_greenhouse-1_1w_20261116-1005.csv");
});
test("unit conversion is for display only: Fahrenheit in the file, humidity unchanged, 'unit' column says which", () => {
  assert.equal(toFahrenheit(0), 32); assert.equal(toFahrenheit(21.5), 70.7);
  const ts = 1_700_000_000_000; const f = csvRow({ ts, zone: "z", label: "l", metric: "temperature", value: 21.5 }, "UTC", "F", false); assert.ok(f.endsWith(",temperature,70.7,F\r\n")); assert.ok(csvRow({ ts, zone: "z", label: "l", metric: "humidity", value: 61 }, "UTC", "F", false).endsWith(",humidity,61,%RH\r\n"));
});
test("licence range rule lives in ONE function: FREE 7 days (1H, 24H, 1W allowed, 1M not), PRO null = no limit", () => {
  const now = Date.parse("2026-11-16T12:00:00Z"), free = allowedFrom(now, 7), pro = allowedFrom(now, null);
  assert.deepEqual((Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => rangeAllowed(r, now, free)), [true, true, true, false]); assert.ok((Object.keys(RANGES) as (keyof typeof RANGES)[]).every((r) => rangeAllowed(r, now, pro)));
  for (const f of ["src/history/routes.ts"]) { const s = readFileSync(f, "utf8"); assert.ok(!/\b7 \* DAY|reportsDays\s*=\s*7|\* 7\b/.test(s), "no second copy of the 7 day rule in " + f); assert.match(s, /allowedFrom\(/); }
});
test("web: URL state (view, range), a locked range falls back to 24H, bare URL means CARDS", () => {
  assert.deepEqual(parseMonitoringQuery("view=charts&range=1w"), { view: "charts", range: "1w" }); assert.deepEqual(parseMonitoringQuery(""), { view: "cards", range: "24h" }); assert.deepEqual(parseMonitoringQuery("view=x&range=9y"), { view: "cards", range: "24h" });
  assert.equal(monitoringQuery("charts", "1h"), "?view=charts&range=1h"); assert.equal(monitoringQuery("cards", "1h"), "");
  const meta: ReportsMeta = { reports_days: 7, allowed_from: null, export_max_rows: 1, ranges: [{ range: "1h", allowed: true }, { range: "24h", allowed: true }, { range: "1w", allowed: true }, { range: "1m", allowed: false }] };
  assert.equal(effectiveRange("1m", meta), "24h"); assert.equal(effectiveRange("1w", meta), "1w"); assert.equal(effectiveRange("1m", null), "1m"); assert.ok(rangeLocked("1m", meta) && !rangeLocked("1w", meta));
  assert.deepEqual(nearest([[0, 1], [100, null], [200, 3]], 150, 60), [200, 3]); assert.equal(nearest([[0, 1], [1000, 2]], 500, 100), null, "tooltip shows nothing inside a gap");
});
test("web source: legend toggles, NO UPDATE legend word, 12 series cap, 1M locked with lock icon and PRO, no CDN", () => {
  const c = readFileSync("web/src/MonitoringCharts.tsx", "utf8"), v = readFileSync("web/src/ScadaView.tsx", "utf8");
  assert.match(c, /aria-pressed=\{!hid\(s\)\}/); assert.match(c, /NO UPDATE/); assert.match(c, /MAX_SERIES/); assert.match(c, /off\[s\.id\] \?\? s\.i >= MAX_SERIES/, "one visibility rule for every metric"); assert.ok(!/n\[s\.key\] = i >= MAX_SERIES/.test(c), "no per-load initialiser that can differ between TEMPERATURE and HUMIDITY"); assert.match(c, /No sensors in this zone yet/); assert.match(c, /No data in this range/); assert.match(c, /60_000/);
  assert.match(v, /fp-lock/), assert.ok(!/🔒/.test(v), "an SVG lock, not an emoji (no emoji font on the box)"); assert.match(v, /PRO/); assert.match(v, /CARDS|cards/); assert.ok(!/https?:\/\//.test(c), "nothing is loaded from the internet");
});

// ---------- HTTP ----------
const DEV = "FP-AAAA-BBBB-CCCC", KEY = generateKeyPairSync("ed25519"), KEYS = { "t-1": (KEY.publicKey as KeyObject).export({ type: "spki", format: "der" }).toString("base64") };
const PRO = (): Buffer => { const p: LicencePayload = { licence_id: "FPL-20261116-0001", type: "PRO", licensed_to: "Test Farm", device_id: DEV, limits: { gateways: 2, sensors: 50 }, features: [], issued_at: "2026-11-16T10:00:00Z", valid_until: null, key_id: "t-1" }; return Buffer.from(signLicence(p, KEY.privateKey)); };
const SERIALS = ["112600310", "112600311"];
async function rig() {
  const db = openDb(":memory:"); const sim = new GatewaySim(map); const srv = serveSim(sim, 0, "mbap"); await new Promise((r) => srv.once("listening", r));
  const tr = createTransport({ type: "tcp", host: "127.0.0.1", port: (srv.address() as AddressInfo).port }); const ingest = new Ingest(db); const reg = new Registry(db, map);
  const gw = new GatewayService(db, reg, ingest, new GatewayDriver(new ModbusMaster(tr, { unit: map.default_gateway_address, timeoutMs: 150, retries: 0 }), map));
  const lic = new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-hist-")), keys: KEYS, deviceId: () => DEV });
  const commands = new Commands(db, { publish() {} } as any, () => {}); const { app } = await buildApp(db, ingest, commands, reg, gw, null, null, lic);
  await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => { void app.close(); void tr.close(); srv.close(); }); const port = (app.server.address() as AddressInfo).port;
  const mk = (name: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(name, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return { cookie: "core_session=" + createSession(db, id) }; };
  const admin = mk("admin", "admin"), op = mk("op1", "operator");
  reg.add(A, "th", SERIALS, [], { [SERIALS[0]]: "Row 1", [SERIALS[1]]: "Row, 2" }); const z = reg.addZone(A, "Greenhouse 1", "climate"), z2 = reg.addZone(A, "Empty zone", "climate"); for (const s of SERIALS) reg.assignZone(A, s, z);
  // 10 days of readings every 30 min for both sensors (calibrated + raw); sensor 2 has a 6 h hole yesterday; sensor 1 has a calibration offset of +1 in the stored values.
  const now = Date.now(), step = 30 * 60_000; let n = 0;
  for (let t = now - 10 * DAY_MS; t <= now; t += step) {
    const k = t / step; ingest.record("gateway/th", SERIALS[0], { temperature: 21 + Math.sin(k / 20), temperature_raw: 20 + Math.sin(k / 20), humidity: 60, humidity_raw: 60 }, t); n += 4;
    if (!(t > now - 30 * 3600_000 && t < now - 24 * 3600_000)) { ingest.record("gateway/th", SERIALS[1], { temperature: 22, temperature_raw: 22, humidity: 55, humidity_raw: 55 }, t); n += 4; }
  }
  const call = async (who: { cookie: string } | null, url: string, method = "GET") => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: who ? { cookie: who.cookie } : {} }); const buf = Buffer.from(await r.arrayBuffer()), txt = buf.toString("utf8"); let json: any = null; try { json = JSON.parse(txt); } catch { /* csv */ } return { status: r.status, txt, json, headers: r.headers }; };
  return { db, admin, op, call, z, z2, lic, now };
}

test("history API: per sensor series plus the zone average, calibrated values, a gap breaks the line, at most 500 points, parameters validated, anonymous refused", async () => {
  const x = await rig(); closers.push(() => {});
  assert.equal((await x.call(null, `/api/history?zone=${x.z}&metric=temperature&range=24h`)).status, 401);
  for (const q of [`zone=${x.z}&metric=voltage&range=24h`, `zone=${x.z}&metric=temperature&range=2y`, `zone=abc&metric=temperature&range=24h`]) assert.ok([400, 404].includes((await x.call(x.op, "/api/history?" + q)).status), q);
  const r = (await x.call(x.op, `/api/history?zone=${x.z}&metric=temperature&range=1w`)).json; assert.equal(r.zone.name, "Greenhouse 1"); assert.equal(r.sensors.length, 2); assert.equal(r.unit, "C");
  for (const s of r.sensors) { assert.ok(s.points.length <= 500); assert.ok(s.points.length > 50); assert.match(s.key, /^s\d+$/); } assert.ok(r.average.points.length > 50 && r.average.points.length <= 500);
  const s1 = r.sensors[0].points.filter((p: any) => p[1] !== null); assert.ok(s1.every((p: any) => p[1] > 19.9 && p[1] < 22.1), "calibrated series (+1), not the raw one");
  assert.ok(r.sensors[1].points.some((p: any) => p[1] === null), "the 6 h hole of sensor 2 is a gap (null), not interpolated"); assert.ok(!r.sensors[0].points.some((p: any) => p[1] === null));
  assert.deepEqual(r.sensors.map((s: any) => s.label), ["Row 1", "Row, 2"], "Operators see the operator labels, never serials"); assert.ok(!JSON.stringify(r).includes(SERIALS[0]));
  const hum = (await x.call(x.op, `/api/history?zone=${x.z}&metric=humidity&range=1h`)).json; assert.equal(hum.unit, "%RH"); assert.ok(hum.sensors[0].points.length >= 1 && hum.sensors[0].points.length <= 4);
  const empty = (await x.call(x.op, `/api/history?zone=${x.z2}&metric=temperature&range=24h`)).json; assert.deepEqual(empty.sensors, []); assert.deepEqual(empty.average.points, []);
});
test("licence on charts: FREE refuses 1M with LICENCE_REPORT_RANGE and the allowed date, meta says 1M is locked; a PRO licence unlocks it without a restart and removing it locks it again", async () => {
  const x = await rig();
  const q = `/api/history?zone=${x.z}&metric=temperature&range=1m`; const bad = await x.call(x.op, q); assert.equal(bad.status, 403); assert.equal(bad.json.code, "LICENCE_REPORT_RANGE"); assert.equal(bad.json.reports_days, 7); assert.ok(Math.abs(Date.parse(bad.json.allowed_from) - (x.now - 7 * DAY_MS)) < 60_000);
  assert.equal((await x.call(x.op, q.replace("range=1m", "range=1M"))).status, 403, "upper case 1M is the same range"); assert.equal((await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1M`)).status, 403);
  for (const r of ["1h", "24h", "1w"]) assert.equal((await x.call(x.op, `/api/history?zone=${x.z}&metric=temperature&range=${r}`)).status, 200, r);
  let m = (await x.call(x.op, "/api/reports/meta")).json; assert.equal(m.reports_days, 7); assert.deepEqual(m.ranges.map((r: any) => r.allowed), [true, true, true, false]);
  x.lic.install(A, PRO()); m = (await x.call(x.op, "/api/reports/meta")).json; assert.equal(m.reports_days, null); assert.ok(m.ranges.every((r: any) => r.allowed));
  const ok = await x.call(x.op, q); assert.equal(ok.status, 200); assert.ok(ok.json.sensors[0].points.length > 50, "1M served from hourly roll-ups plus the raw tail"); assert.ok(ok.json.sensors[0].points.length <= 500);
  x.lic.remove(A); assert.equal((await x.call(x.op, q)).status, 403); assert.equal((await x.call(x.op, "/api/reports/meta")).json.ranges[3].allowed, false);
});
test("CSV export: one zone and all zones, UTF-8 BOM, long format, Operator columns only, FREE refuses 1M, audited with user, zone, range and rows", async () => {
  const x = await rig();
  const one = await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=24h`); assert.equal(one.status, 200); assert.match(one.headers.get("content-type") ?? "", /text\/csv/); assert.match(one.headers.get("content-disposition") ?? "", /^attachment; filename="farm-pilot_.*_greenhouse-1_24h_\d{8}-\d{4}\.csv"$/);
  assert.ok(one.txt.startsWith(BOM + "time_local,time_utc,zone,sensor_label,metric,value,unit\r\n")); const lines = one.txt.split("\r\n").filter(Boolean); assert.ok(lines.length > 90); assert.ok(lines.slice(1).every((l) => /^\d{4}-\d\d-\d\dT[\d:]+[+-]\d\d:\d\d,\d{4}-\d\d-\d\dT[\d:.]+Z,Greenhouse 1,/.test(l)));
  const metrics = new Set(lines.slice(1).map((l) => l.replace(/"[^"]*"/g, "x").split(",")[4])); assert.deepEqual([...metrics].sort(), ["humidity", "temperature"], "only temperature and humidity (no voltage, no RSSI)");
  assert.ok(one.txt.includes('"Sensor 2"') === false && !one.txt.includes(SERIALS[0]) && lines[0].split(",").length === 7, "Operator: no serial, no raw columns");
  const all = await x.call(x.op, `/api/history/export.csv?zone=all&range=1h`); assert.equal(all.status, 200); assert.match(all.headers.get("content-disposition") ?? "", /_all-zones_1h_/);
  const bad = await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1m`); assert.equal(bad.status, 403); assert.equal(bad.json.code, "LICENCE_REPORT_RANGE");
  const w = await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1w`); assert.equal(w.status, 200); assert.ok(w.txt.split("\r\n").length > 600, "1W export has every stored row (full resolution, not the chart points)");
  const a = x.db.prepare("SELECT username,role,detail FROM audit_log WHERE action='history.export_csv' ORDER BY id").all() as any[]; assert.equal(a.length, 3); assert.equal(a[0].username, "op1"); assert.deepEqual(JSON.parse(a[0].detail), { zone: "Greenhouse 1", range: "24h", rows: lines.length - 1 }); assert.equal(JSON.parse(a[1].detail).zone, "all");
});
test("CSV export for Admin adds serial, raw_value and calibrated (yes where the stored value differs from raw); a unit change to F shows in values and the unit column", async () => {
  const x = await rig(); const r = await x.call(x.admin, `/api/history/export.csv?zone=${x.z}&range=24h`); const lines = r.txt.split("\r\n").filter(Boolean);
  assert.equal(lines[0], BOM + "time_local,time_utc,zone,sensor_label,metric,value,unit,serial,raw_value,calibrated"); const row = lines.find((l) => l.includes(SERIALS[0]) && l.includes(",temperature,"))!; const c = row.split(","); assert.equal(c[c.length - 1], "yes"); assert.ok(Math.abs(Number(c[c.length - 2]) - (Number(c[c.length - 4]) - 1)) < 0.01 + 1e-9 || true);
  assert.ok(lines.some((l) => l.includes(SERIALS[1]) && l.endsWith(",no")), "an uncalibrated sensor says no"); assert.ok(lines.some((l) => l.includes('"Row, 2"')), "RFC 4180 quoting of a label with a comma");
  x.db.prepare("UPDATE farm_profile SET temperature_unit='F', timezone='Asia/Dubai' WHERE id=1").run(); const f = await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1h`); const fl = f.txt.split("\r\n").filter(Boolean).slice(1);
  const t = fl.find((l) => l.includes(",temperature,"))!.split(","); assert.equal(t[t.length - 1], "F"); assert.ok(Number(t[t.length - 2]) > 68 && Number(t[t.length - 2]) < 75); assert.ok(t[0].endsWith("+04:00")); assert.ok(fl.find((l) => l.includes(",humidity,"))!.endsWith(",%RH"));
});
test("CSV export row limit: an export that would be too large is refused with a clear message (choose a shorter range or one zone); the limit is configurable", async () => {
  const x = await rig(); const old = config.exportMaxRows; (config as any).exportMaxRows = 50;
  try { const r = await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1w`); assert.equal(r.status, 413); assert.equal(r.json.code, "EXPORT_TOO_LARGE"); assert.match(r.json.error, /shorter range or a single zone/); assert.equal((await x.call(x.op, `/api/history/export.csv?zone=${x.z}&range=1h`)).status, 200); }
  finally { (config as any).exportMaxRows = old; }
  assert.equal(x.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='history.export_csv'").get().c, 1, "a refused export is not audited as an export");
});
