// 2026-11-16 -- THE ONE PLACE for the chart / CSV / Reports history range rule (change request core-control-section-and-scada-charts.md, section 9).
// `reports_days` from the licence limits: FREE 7, PRO null (= any range inside the kept history). The history endpoint, the CSV export, the chart range buttons
// (through /api/reports/meta) and Reports all call allowedFrom(), so changing the rule means changing this file only.
// Licence v2 carries reports_days and retention_days (null = unlimited). A v1 file has neither: reports unlimited inside retention, retention 365 days. FREE, EXPIRED and INVALID use the FREE numbers.
// The summary (licence/service.ts) resolves all of that once; these two functions only read it.
import type { LicenceSummary } from "./summary.js";

export const DAY_MS = 86_400_000;
export const reportsDaysFor = (s: Pick<LicenceSummary, "reports_days">): number | null => s.reports_days;
/** History retention in days; null = never prune. FREE 90. */
export const retentionDaysFor = (s: Pick<LicenceSummary, "retention_days">): number | null => s.retention_days;
/** Earliest instant a chart or export may reach back to. 0 = no licence limit (retention still applies). */
export const allowedFrom = (now: number, reportsDays: number | null): number => (reportsDays === null ? 0 : now - reportsDays * DAY_MS);
