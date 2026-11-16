// 2026-11-16 -- THE ONE PLACE for the chart / CSV / Reports history range rule (change request core-control-section-and-scada-charts.md, section 9).
// `reports_days` from the licence limits: FREE 7, PRO null (= any range inside the kept history). The history endpoint, the CSV export, the chart range buttons
// (through /api/reports/meta) and Reports all call allowedFrom(), so changing the rule means changing this file only.
// NOTE: the signed licence file format is frozen at limits {gateways, sensors}, so a LICENSED box is "unlimited inside retention" and every other state
// (FREE, EXPIRED, INVALID) uses the FREE number. If a per-licence value is ever added to the file format, it is read in reportsDaysFor() and nowhere else.
import { FREE_LICENCE } from "./free.js";
import type { LicenceSummary } from "./summary.js";

export const DAY_MS = 86_400_000;
export const reportsDaysFor = (s: Pick<LicenceSummary, "state">): number | null => (s.state === "LICENSED" ? null : FREE_LICENCE.reportsDays);
/** Earliest instant a chart or export may reach back to. 0 = no licence limit (retention still applies). */
export const allowedFrom = (now: number, reportsDays: number | null): number => (reportsDays === null ? 0 : now - reportsDays * DAY_MS);
