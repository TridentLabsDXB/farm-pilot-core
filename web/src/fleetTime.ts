// 2026-11-19 -- Connected Boxes: every date and time in the time zone of this server's Farm Profile (fmtCfg.tz, set by App from /farm-profile/public, the same source as the header clock). Display only.
// Same formatting rules as src/fleet/time.ts (UTC fallback for a missing or unknown zone). No zone is hard-coded.
const ok = (tz: unknown): tz is string => { if (typeof tz !== "string" || !tz) return false; try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } };
export const zoneOf = (tz: unknown): string => (ok(tz) ? tz : "UTC");
export function zoneLabel(tz: unknown, ts: number): string {
  const z = zoneOf(tz); if (z === "UTC") return "UTC";
  try { const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, timeZoneName: "longOffset" }).formatToParts(new Date(ts)).find((x) => x.type === "timeZoneName")?.value ?? "GMT"; const m = /GMT([+-])(\d\d):(\d\d)/.exec(p); if (!m) return "UTC"; return "UTC" + m[1] + String(Number(m[2])) + (m[3] !== "00" ? ":" + m[3] : ""); } catch { return "UTC"; }
}
const parts = (tz: unknown, ts: number) => { const o: Record<string, string> = {}; for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: zoneOf(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts))) o[p.type] = p.value; return o; };
/** "2026-11-19" in the zone. */
export const dayKey = (tz: unknown, ts: number) => { const p = parts(tz, ts); return `${p.year}-${p.month}-${p.day}`; };
/** "2026-11-19 00:18 UTC+4" */
export const stamp = (tz: unknown, ts: number) => { const p = parts(tz, ts); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${zoneLabel(tz, ts)}`; };
/** "2026-11-19 (UTC+4)" -- a date with the zone, for FIRST ENROLLED. */
export const dayStamp = (tz: unknown, ts: number) => `${dayKey(tz, ts)} (${zoneLabel(tz, ts)})`;
const shift = (key: string, days: number) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
export interface HourRow { hour_ts: number; expected: number; received: number; }
export interface DayCell { key: string; expected: number; received: number; pct: number | null; }
/** 30 day cells, oldest first, the last one = today in the zone. Day boundaries are LOCAL midnights: with Asia/Dubai (UTC+4) the UTC hours 20:00-23:59 belong to the NEXT day. Hourly records stay UTC hours; a half-hour zone puts each UTC hour into the local day it starts in. */
export function groupDays(tz: unknown, hours: HourRow[], now: number, n = 30): DayCell[] {
  const today = dayKey(tz, now), cells: DayCell[] = Array.from({ length: n }, (_, i) => ({ key: shift(today, i - (n - 1)), expected: 0, received: 0, pct: null }));
  const at = new Map(cells.map((c) => [c.key, c])); for (const h of hours) { const c = at.get(dayKey(tz, h.hour_ts)); if (c) { c.expected += h.expected; c.received += Math.min(h.received, h.expected || h.received); } }
  for (const c of cells) c.pct = c.expected > 0 ? Math.min(100, Math.round((c.received / c.expected) * 1000) / 10) : null; return cells;
}
