// 2026-11-19 -- Connected Boxes (Online build). Pure rules, `now` injected. All of it is computed on the SERVER clock; the box's own clock (sent_at) is never used for a decision.
export const ALLOWED_INTERVALS = [60, 300, 900] as const;
export const LATE_EXTRA_MS = 15 * 60_000;          // LATE lasts 15 minutes beyond 3 intervals, then OFFLINE
export const HISTORY_DAYS = 30;
export const HOUR = 3_600_000, DAY = 86_400_000;
export type BoxStatus = "ONLINE" | "LATE" | "OFFLINE" | "NOT_ENROLLED";

/** Nearest allowed interval (1, 5 or 15 minutes). A box that reports nonsense is judged as a 1-minute box, the strictest. */
export function clampInterval(v: unknown): number { const n = Number(v); if (!Number.isFinite(n)) return 60; return ALLOWED_INTERVALS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a)); }
/** ONLINE while the last report is younger than 3 intervals; LATE up to 15 minutes more; OFFLINE after that; NOT ENROLLED until the first report. */
export function boxStatus(lastReportAt: number | null, intervalS: number, now: number): BoxStatus {
  if (lastReportAt === null) return "NOT_ENROLLED";
  const age = now - lastReportAt, three = 3 * clampInterval(intervalS) * 1000;
  return age < three ? "ONLINE" : age < three + LATE_EXTRA_MS ? "LATE" : "OFFLINE";
}
/** When a silent box turns LATE and OFFLINE (server time), for exact history events. */
export const lateAt = (last: number, intervalS: number) => last + 3 * clampInterval(intervalS) * 1000;
export const offlineAt = (last: number, intervalS: number) => lateAt(last, intervalS) + LATE_EXTRA_MS;
export const hourStart = (ms: number) => Math.floor(ms / HOUR) * HOUR;
export const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
