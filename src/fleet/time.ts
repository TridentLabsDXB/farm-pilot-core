// 2026-11-19 -- Connected Boxes shows times in the time zone of THIS server's Farm Profile (owner change request). Display only: storage, API fields and reports stay UTC ISO-8601 / epoch ms.
// No zone is hard-coded anywhere; an unknown or missing zone falls back to UTC. web/src/fleetTime.ts holds the same two helpers for the page (the web bundle cannot import from src/); test/fleet-time.test.ts runs both against the same cases.
const ok = (tz: unknown): tz is string => { if (typeof tz !== "string" || !tz) return false; try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } };
export const zoneOf = (tz: unknown): string => (ok(tz) ? tz : "UTC");
/** "UTC", "UTC+4", "UTC-3", "UTC+5:30" for the offset the zone has at `ts`. */
export function zoneLabel(tz: unknown, ts: number): string {
  const z = zoneOf(tz); if (z === "UTC") return "UTC";
  try { const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, timeZoneName: "longOffset" }).formatToParts(new Date(ts)).find((x) => x.type === "timeZoneName")?.value ?? "GMT"; const m = /GMT([+-])(\d\d):(\d\d)/.exec(p); if (!m) return "UTC"; return "UTC" + m[1] + String(Number(m[2])) + (m[3] !== "00" ? ":" + m[3] : ""); } catch { return "UTC"; }
}
/** "2026-11-19 00:18:05" in the zone. */
export function localStamp(tz: unknown, ts: number, seconds = true): string {
  const o: Record<string, string> = {}; for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: zoneOf(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts))) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}${seconds ? ":" + o.second : ""}`;
}
