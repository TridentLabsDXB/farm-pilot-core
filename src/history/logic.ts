// 2026-11-16 -- pure helpers for the MONITORING charts and the CSV export (change request core-control-section-and-scada-charts.md, sections 3 and 4).
// No database, no HTTP: everything here is unit tested on its own (test/history.test.ts).
import { DAY_MS } from "../licence/range.js";

export const HOUR_MS = 3_600_000;
export const RANGES = { "1h": HOUR_MS, "24h": DAY_MS, "1w": 7 * DAY_MS, "1m": 30 * DAY_MS } as const;
export type Range = keyof typeof RANGES;
export const isRange = (v: unknown): v is Range => typeof v === "string" && Object.prototype.hasOwnProperty.call(RANGES, v);
export const METRICS = ["temperature", "humidity"] as const;
export type Metric = (typeof METRICS)[number];
export const isMetric = (v: unknown): v is Metric => v === "temperature" || v === "humidity";
export const POINT_CAP = 500;                // server side cap per series: 1W and 1M stay light
export const GAP_INTERVALS = 3;              // a hole longer than this many reporting intervals breaks the line
/** 1H, 24H and 1W are served from raw rows, 1M (and longer) from the hourly roll-ups. */
export const usesRollup = (r: Range) => RANGES[r] > 7 * DAY_MS;
/** Ranges the licence allows: the span must fit inside allowedFrom (computed with the same `now`, so 1W is allowed on a 7 day limit). */
export const rangeAllowed = (r: Range, now: number, allowed: number) => now - RANGES[r] >= allowed;

export type Pt = [number, number];
export type GapPt = [number, number | null];

/** Time-bucket average down to at most `cap` points. The first and the last point are always kept as they are. */
export function downsample(p: Pt[], cap = POINT_CAP): Pt[] {
  if (p.length <= cap || cap < 3) return p.length <= cap ? p : [p[0], p[p.length - 1]];
  const inner = p.slice(1, -1), k = cap - 2, t0 = inner[0][0], t1 = inner[inner.length - 1][0], w = (t1 - t0) / k || 1;
  const b = new Map<number, { n: number; st: number; sv: number }>();
  for (const [t, v] of inner) { const i = Math.min(k - 1, Math.floor((t - t0) / w)); const x = b.get(i) ?? { n: 0, st: 0, sv: 0 }; x.n++; x.st += t; x.sv += v; b.set(i, x); }
  return [p[0], ...[...b.entries()].sort((a, c) => a[0] - c[0]).map(([, x]): Pt => [Math.round(x.st / x.n), x.sv / x.n]), p[p.length - 1]];
}

/** Do not interpolate across missing data: where two neighbours are more than `thresholdMs` apart, a null point (a break in the line) is put between them. */
export function withGaps(p: Pt[], thresholdMs: number): GapPt[] {
  const out: GapPt[] = [];
  for (let i = 0; i < p.length; i++) { if (i > 0 && p[i][0] - p[i - 1][0] > thresholdMs) out.push([Math.round((p[i][0] + p[i - 1][0]) / 2), null]); out.push(p[i]); }
  return out;
}

/** Zone average: per time bucket, the mean of the per-sensor means of the sensors that reported in that bucket (a sensor with no value in a bucket is simply not in it). */
export function zoneAverage(series: Pt[][], from: number, bucketMs: number): Pt[] {
  const b = new Map<number, Map<number, { n: number; s: number; st: number }>>();
  series.forEach((pts, si) => { for (const [t, v] of pts) { const i = Math.floor((t - from) / bucketMs), m = b.get(i) ?? new Map(); const x = m.get(si) ?? { n: 0, s: 0, st: 0 }; x.n++; x.s += v; x.st += t; m.set(si, x); b.set(i, m); } });
  return [...b.entries()].sort((a, c) => a[0] - c[0]).map(([, m]): Pt => { const xs = [...m.values()]; return [Math.round(xs.reduce((s, x) => s + x.st / x.n, 0) / xs.length), xs.reduce((s, x) => s + x.s / x.n, 0) / xs.length]; });
}
/** Bucket width for the zone average: the chart resolution, but never finer than a minute or than the slowest sensor's reporting interval (sensors report independently). */
export const bucketMs = (spanMs: number, slowestIntervalMs: number) => Math.max(60_000, slowestIntervalMs, Math.ceil(spanMs / POINT_CAP));
export const gapThresholdMs = (intervalMs: number, bucket: number) => GAP_INTERVALS * Math.max(intervalMs, bucket);

export const toFahrenheit = (c: number) => Math.round((c * 9 / 5 + 32) * 1000) / 1000;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------- CSV ----------
export const BOM = "﻿";
/** RFC 4180 quoting. Text that starts with = + - @ gets a leading apostrophe so a spreadsheet never runs it as a formula (labels are typed by people). */
export function csvText(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvNum = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "" : String(round3(v)));   // dot decimal, no locale
export const csvLine = (cells: string[]) => cells.join(",") + "\r\n";
export const CSV_OPERATOR_COLUMNS = ["time_local", "time_utc", "zone", "sensor_label", "metric", "value", "unit"] as const;
export const CSV_ADMIN_COLUMNS = [...CSV_OPERATOR_COLUMNS, "serial", "raw_value", "calibrated"] as const;

const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string) {
  let f = fmts.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }); fmts.set(tz, f); }
  const o: Record<string, string> = {}; for (const p of f.formatToParts(ts)) o[p.type] = p.value; return o;
}
/** ISO 8601 with the UTC offset, in the Farm Profile time zone: 2026-11-16T14:05:00+04:00. */
export function isoLocal(ts: number, tz: string): string {
  const p = parts(ts, tz), off = /GMT([+-]\d{2}:\d{2})/.exec(p.timeZoneName ?? "")?.[1] ?? "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
export const stampLocal = (ts: number, tz: string) => { const p = parts(ts, tz); return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`; };
export const slug = (s: string, fallback: string) => s.normalize("NFKD").replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
export const csvFileName = (farm: string, zone: string | "all", range: Range, ts: number, tz: string) => `farm-pilot_${slug(farm, "farm")}_${zone === "all" ? "all-zones" : slug(zone, "zone")}_${range}_${stampLocal(ts, tz)}.csv`;

export interface CsvRowIn { ts: number; zone: string; label: string; metric: Metric; value: number; serial?: string; raw?: number | null; }
/** One reading as one CSV line. `admin` adds serial, raw_value and calibrated. Temperature follows the display unit (the `unit` column says which). Raw values only for Admin. */
export function csvRow(r: CsvRowIn, tz: string, tempUnit: "C" | "F", admin: boolean): string {
  const conv = (v: number) => (r.metric === "temperature" && tempUnit === "F" ? toFahrenheit(v) : v);
  const unit = r.metric === "temperature" ? (tempUnit === "F" ? "F" : "C") : "%RH";
  const cells = [isoLocal(r.ts, tz), new Date(r.ts).toISOString(), csvText(r.zone), csvText(r.label), r.metric, csvNum(conv(r.value)), unit];
  if (admin) cells.push(csvText(r.serial ?? ""), csvNum(r.raw === null || r.raw === undefined ? null : conv(r.raw)), r.raw === null || r.raw === undefined ? "" : r.raw !== r.value ? "yes" : "no");
  return csvLine(cells);
}
export const csvHeader = (admin: boolean) => BOM + csvLine([...(admin ? CSV_ADMIN_COLUMNS : CSV_OPERATOR_COLUMNS)]);
