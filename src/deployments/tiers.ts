// 2026-11-18 -- Licence tiers recorded on the Licence Management page (owner decision, core-licence-tiers.md). THE ONE PLACE for these numbers on this page: the API validation, the status / usage
// rules, the dialog (the page receives this table from GET /api/licence-deployments) and the tests all read TIERS.
//   FREE 1 data source / 10 sensors, PRO 5 / 50, FULL 25 / 250. The UI word is DATA SOURCES; internally it is the existing `gateways` limit (no column or licence-file field is renamed).
// ENGINEERING (unlimited data sources and sensors, no expiry by default, Trident Labs machines) is a selectable FOURTH type (owner, 2026-11-18): every limit null = unlimited.
// reports_days / retention_days: FREE 7 / 90 (licence/free.ts). PRO: any report date, 1 year of history. FULL: NOT DEFINED YET by the owner (open question 1), recorded like PRO until confirmed: FULL_REPORTS_RETENTION_TO_BE_CONFIRMED.
import { FREE_LICENCE } from "../licence/free.js";

export type Tier = "FREE" | "PRO" | "FULL" | "ENGINEERING";
export interface TierLimits { gateways: number | null; sensors: number | null; reports_days: number | null; retention_days: number | null; }
export const TIERS: Record<Tier, TierLimits> = {
  FREE: { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors, reports_days: FREE_LICENCE.reportsDays, retention_days: FREE_LICENCE.retentionDays },
  PRO: { gateways: 5, sensors: 50, reports_days: null, retention_days: 365 },
  FULL: { gateways: 25, sensors: 250, reports_days: null, retention_days: 365 },
  ENGINEERING: { gateways: null, sensors: null, reports_days: null, retention_days: null },   // licence v2: null = unlimited / never pruned
};
export const FULL_REPORTS_RETENTION_TO_BE_CONFIRMED = true;
export const TIER_NAMES = Object.keys(TIERS) as Tier[];
export const isTier = (t: unknown): t is Tier => typeof t === "string" && Object.prototype.hasOwnProperty.call(TIERS, t);
/** The paid tiers a licence can be issued for. */
export const PAID_TIERS: Tier[] = ["PRO", "FULL", "ENGINEERING"];
