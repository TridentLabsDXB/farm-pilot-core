// The licence part of /api/about. FREE until a licence is installed (Step 2 of the About work replaces `freeSummary` with the real service, same shape).
import type { Db } from "../db.js";
import { FREE_LICENCE } from "./free.js";
import { usage, type Usage } from "./usage.js";

export type LicenceState = "FREE" | "LICENSED" | "EXPIRED" | "INVALID";
/** null = unlimited (licence v2). */
export interface LimitSet { gateways: number | null; sensors: number | null; }
export interface LicenceSummary { type: string; licensed_to: string | null; valid_until: string | null; state: LicenceState; limits: LimitSet; usage: Usage; over_limit: boolean; reason?: string;
  reports_days: number | null; retention_days: number | null; }      // how far back charts / CSV / Reports reach and how long history is kept; null = unlimited / never prune
export const over = (used: number, limit: number | null) => limit !== null && used > limit;
export const overLimit = (u: Usage, l: LimitSet) => over(u.sensors, l.sensors) || over(u.gateways, l.gateways);
export function freeSummary(db: Db): LicenceSummary {
  const limits = { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors }, u = usage(db);
  return { type: FREE_LICENCE.type, licensed_to: null, valid_until: null, state: "FREE", limits, usage: u, over_limit: overLimit(u, limits), reports_days: FREE_LICENCE.reportsDays, retention_days: FREE_LICENCE.retentionDays };
}
