// 2026-11-16 -- history for the MONITORING charts, CSV export and the licence range meta (change request core-control-section-and-scada-charts.md, sections 3, 4 and 9).
// Any logged-in user. Operators get calibrated values and operator labels only: no serials, raw values, slots or register addresses. The licence range rule lives in licence/range.ts.
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { audit, type Db } from "../db.js";
import { config } from "../config.js";
import { buildView } from "../gateway/health.js";
import type { ProfileService } from "../gateway/profile.js";
import { HttpError, topicFor, type Registry, type SensorRow } from "../gateway/registry.js";
import type { GatewayService } from "../gateway/service.js";
import { allowedFrom } from "../licence/range.js";
import type { LicenceService } from "../licence/service.js";
import { bucketMs, csvFileName, csvHeader, csvRow, downsample, gapThresholdMs, HOUR_MS, isMetric, isRange, METRICS, RANGES, rangeAllowed, usesRollup, withGaps, zoneAverage, type Metric, type Pt, type Range } from "./logic.js";

import { latestOf, mappedSources, mappedStatus, seriesIdOf } from "../mapped/index.js";

export interface HistoryDeps { db: Db; reg: Registry; svc: GatewayService; prof: ProfileService; licence: LicenceService; now?: () => number; }
const hits = new Map<string, number[]>();
/** At most `max` calls per user and kind in a minute (in memory; a restart resets it, which is fine for a courtesy limit). */
function rateLimit(user: string, kind: string, max: number) {
  const now = Date.now(), k = `${kind}|${user}`, a = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
  if (a.length >= max) { hits.set(k, a); throw new HttpError(429, "Too many requests. Wait a minute and try again.", { code: "RATE_LIMITED" }); }
  a.push(now); hits.set(k, a); if (hits.size > 500) for (const [key, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(key);
}

export function seriesId(db: Db, type: string, serial: string, metric: string): number | null {
  return (db.prepare("SELECT id FROM series WHERE topic=? AND sensor_key=? AND metric=?").get(topicFor(type), serial, metric) as { id: number } | undefined)?.id ?? null;
}
/** Calibrated readings of one sensor: raw rows for 1H, 24H and 1W. For 1M: hourly points, from the roll-up table for hours whose raw rows have expired and from the raw rows themselves wherever they still exist
 *  (raw wins: the roll-up job runs every few hours, so the newest hours are not in it yet, and it is derived from the same rows anyway). */
export function readSeries(db: Db, id: number, from: number, to: number, rollup: boolean): Pt[] {
  if (!rollup) return (db.prepare("SELECT ts,value v FROM history_raw WHERE series_id=? AND ts>=? AND ts<=? ORDER BY ts").all(id, from, to) as { ts: number; v: number }[]).map((r): Pt => [r.ts, r.v]);
  const byHour = new Map<number, number>();
  for (const r of db.prepare("SELECT hour_ts h,avg v FROM rollup_hourly WHERE series_id=? AND hour_ts>=? AND hour_ts<=?").all(id, Math.floor(from / HOUR_MS) * HOUR_MS, to) as { h: number; v: number }[]) byHour.set(r.h, r.v);
  for (const r of db.prepare("SELECT (ts/?)*? h,AVG(value) v FROM history_raw WHERE series_id=? AND ts>=? AND ts<=? GROUP BY ts/?").all(HOUR_MS, HOUR_MS, id, from, to, HOUR_MS) as { h: number; v: number }[]) byHour.set(r.h, r.v);
  return [...byHour.entries()].sort((a, c) => a[0] - c[0]).map(([h, v]): Pt => [h + HOUR_MS / 2, v]);
}

export function registerHistoryRoutes(app: FastifyInstance, d: HistoryDeps) {
  const now = d.now ?? Date.now;
  const who = (req: any) => ({ username: req.user.username as string, role: req.user.role as string, admin: req.user.role === "admin" });
  /** Refuses a range the licence does not allow, with the earliest allowed date. One function for the chart endpoint and the export. */
  const checkRange = (range: Range, t: number) => {
    const days = d.licence.reportsDays(), af = allowedFrom(t, days);
    if (!rangeAllowed(range, t, af)) throw new HttpError(403, `The ${range.toUpperCase()} range needs a PRO licence. This box can look at and export the last ${days} days${af ? ` (from ${new Date(af).toISOString().slice(0, 10)})` : ""}.`, { code: "LICENCE_REPORT_RANGE", allowed_from: af ? new Date(af).toISOString() : null, reports_days: days });
  };
  // The UI reads this so it never offers a locked range; it follows a licence change without a restart.
  app.get("/api/reports/meta", async () => {
    const t = now(), days = d.licence.reportsDays(), af = allowedFrom(t, days);
    return { reports_days: days, allowed_from: af ? new Date(af).toISOString() : null, ranges: (Object.keys(RANGES) as Range[]).map((r) => ({ range: r, allowed: rangeAllowed(r, t, af) })), export_max_rows: config.exportMaxRows };
  });

  /** Sensors of a zone in the same order as the SCADA card, with the operator label (Admin: the Admin label) and the live status for the NO UPDATE legend. */
  const zoneSensors = (zoneId: number, admin: boolean) => {
    const view = buildView(d.db, d.reg, d.svc, admin, now()); const rows = d.reg.list();
    return rows.map((s, i) => ({ s, i, label: String(view.sensors[i].label), status: String(view.sensors[i].status) })).filter((x) => x.s.zone_id === zoneId);
  };
  const intervalMs = (s: SensorRow) => d.reg.intervalSec(s.type, s.reporting_interval) * 1000;

  /** 2026-11-18: PLC points and V-BOX tags mapped to this zone (mapped/index.ts): the same lines as sensors in CHARTS and the same rows in the CSV. Label only; the serial column (Admin) is PLC:<zone code> / VBOX:<unit>. */
  const zoneMapped = (zoneId: number) => mappedSources(d.db).filter((m) => m.zoneId === zoneId).map((m) => { const last = Math.max(0, ...Object.values(latestOf(d.db, m)).map((x) => x!.t)); return { m, label: m.label, status: mappedStatus(last, now(), m.intervalMs) }; });
  app.get<{ Querystring: { zone?: string; metric?: string; range?: string } }>("/api/history", async (req) => {
    const u = who(req); rateLimit(u.username, "history", 120);
    const q = req.query, zoneId = Number(q.zone), zone = d.reg.zones().find((z) => z.id === zoneId);
    if (!Number.isInteger(zoneId) || !zone) throw new HttpError(404, "zone not found");
    if (!isMetric(q.metric)) throw new HttpError(400, "metric must be temperature or humidity");
    const rg = String(q.range ?? "").toLowerCase();                       // the buttons say 1M, the URL may too
    if (!isRange(rg)) throw new HttpError(400, "range must be 1h, 24h, 1w or 1m");
    const to = now(), from = to - RANGES[rg]; checkRange(rg, to);
    const ss = zoneSensors(zone.id, u.admin), mp = zoneMapped(zone.id), roll = usesRollup(rg), slow = Math.max(0, ...ss.map((x) => intervalMs(x.s)), ...mp.map((x) => x.m.intervalMs)), bucket = bucketMs(to - from, roll ? HOUR_MS : slow);
    const raw = ss.map((x) => { const id = seriesId(d.db, x.s.type, x.s.serial, q.metric as Metric); return id === null ? [] : readSeries(d.db, id, from, to, roll); });
    const mraw = mp.map((x) => { const id = seriesIdOf(d.db, x.m, q.metric as Metric); return id === null ? [] : readSeries(d.db, id, from, to, roll); });
    const gap = (p: Pt[], iv: number) => withGaps(downsample(p), gapThresholdMs(roll ? HOUR_MS : iv, bucket));
    return { zone: { id: zone.id, name: zone.name }, metric: q.metric, unit: q.metric === "temperature" ? "C" : "%RH", range: rg, from, to, updated_at: to, bucket_ms: bucket,
      sensors: [...ss.map((x, k) => ({ key: `s${x.i + 1}`, label: x.label, status: x.status, points: gap(raw[k], intervalMs(x.s)) })), ...mp.map((x, k) => ({ key: `m${k + 1}`, label: x.label, status: x.status, points: gap(mraw[k], x.m.intervalMs) }))],
      average: { points: withGaps(downsample(zoneAverage([...raw, ...mraw], from, bucket)), gapThresholdMs(slow, bucket)) } };
  });

  app.get<{ Querystring: { zone?: string; range?: string } }>("/api/history/export.csv", async (req, reply) => {
    const u = who(req); rateLimit(u.username, "export", 10);
    const q = req.query, range = String(q.range ?? "").toLowerCase();
    if (!isRange(range)) throw new HttpError(400, "range must be 1h, 24h, 1w or 1m");
    const all = q.zone === "all", zones = d.reg.zones(), zone = all ? null : zones.find((z) => z.id === Number(q.zone));
    if (!all && !zone) throw new HttpError(404, "zone not found");
    const to = now(), from = to - RANGES[range]; checkRange(range, to);
    // Plan: every (zone, sensor, metric) with a stored series, so the row count is known before anything is written.
    const plan: { zone: string; label: string; serial: string; metric: Metric; id: number; rawId: number | null }[] = [];
    for (const z of all ? zones : [zone!]) for (const x of zoneSensors(z.id, u.admin)) for (const m of METRICS) {
      const id = seriesId(d.db, x.s.type, x.s.serial, m); if (id !== null) plan.push({ zone: z.name, label: x.label, serial: x.s.serial, metric: m, id, rawId: u.admin ? seriesId(d.db, x.s.type, x.s.serial, m + "_raw") : null });
    }
    for (const z of all ? zones : [zone!]) for (const x of zoneMapped(z.id)) for (const m of METRICS) { const id = seriesIdOf(d.db, x.m, m); if (id !== null) plan.push({ zone: z.name, label: x.label, serial: x.m.serial, metric: m, id, rawId: null }); }
    const count = d.db.prepare("SELECT COUNT(*) c FROM history_raw WHERE series_id=? AND ts>=? AND ts<=?"); let rows = 0; for (const p of plan) rows += (count.get(p.id, from, to) as { c: number }).c;
    if (rows > config.exportMaxRows) throw new HttpError(413, `This export would have ${rows.toLocaleString("en")} rows, more than the limit of ${config.exportMaxRows.toLocaleString("en")}. Choose a shorter range or a single zone.`, { code: "EXPORT_TOO_LARGE", rows, limit: config.exportMaxRows });
    const info = d.prof.publicInfo(), tz = info.timezone, unit = info.temperature_unit === "F" ? "F" : "C";
    audit(d.db, u.username, u.role, "history.export_csv", { zone: all ? "all" : zone!.name, range, rows });
    const page = d.db.prepare("SELECT ts,value v FROM history_raw WHERE series_id=? AND ts>? AND ts<=? ORDER BY ts LIMIT 5000"), rawAt = d.db.prepare("SELECT ts,value v FROM history_raw WHERE series_id=? AND ts>=? AND ts<=?");
    // Streamed in pages of 5000 rows (a new short query per page, yielding to the event loop in between), so a big export never blocks the box or holds a statement open.
    async function* body() {
      yield csvHeader(u.admin);
      for (const p of plan) {
        let last = from - 1;
        for (;;) {
          const r = page.all(p.id, last, to) as { ts: number; v: number }[]; if (!r.length) break;
          const raws = p.rawId !== null ? new Map((rawAt.all(p.rawId, r[0].ts, r[r.length - 1].ts) as { ts: number; v: number }[]).map((x) => [x.ts, x.v])) : null;
          let chunk = ""; for (const x of r) chunk += csvRow({ ts: x.ts, zone: p.zone, label: p.label, metric: p.metric, value: x.v, serial: p.serial, raw: raws ? raws.get(x.ts) ?? null : undefined }, tz, unit, u.admin);
          yield chunk; last = r[r.length - 1].ts; if (r.length < 5000) break; await new Promise((res) => setImmediate(res));
        }
      }
    }
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${csvFileName(info.farm_name, all ? "all" : zone!.name, range, to, tz)}"`).header("cache-control", "no-store").send(Readable.from(body()));
  });
}
