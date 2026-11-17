// 2026-11-17 -- Licence Management (Online build only): pure status / usage rules, `now` injected so the tests can pin the clock. See docs/licence-management.md.
// Status is NEVER stored: it is computed from valid_until against the SERVER clock. Same rule as the box itself (licence/service.ts): the licence is valid while now < valid_until
// (valid_until is an ISO UTC timestamp, a date-only input is stored as 23:59:59Z of that day, like the signed licence files).
import { FREE_LICENCE } from "../licence/free.js";

export type DeploymentStatus = "active" | "expiring" | "expired" | "free";
export type UsageFlag = "ok" | "at_limit" | "over_limit";
export const EXPIRING_DAYS = 30;
const DAY = 86_400_000;
const utcDay = (ms: number) => Math.floor(ms / DAY);

/** Limits as in licence v2: whole numbers, null = unlimited (reports_days / retention_days included). */
export interface DeploymentLimits { gateways: number | null; sensors: number | null; reports_days: number | null; retention_days: number | null; }
export interface DeploymentUsage { gateways: number; sensors: number; }
/** What a FREE box (and an EXPIRED one) really runs with. Numbers come from licence/free.ts, the one place that holds them. */
export const FREE_LIMITS: DeploymentLimits = { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors, reports_days: FREE_LICENCE.reportsDays, retention_days: FREE_LICENCE.retentionDays };

/** daysLeft = whole UTC calendar days from today to the expiry day (0 = it expires today but is still valid, negative = expired). */
export function deploymentStatus(type: string, validUntil: string | null, now = Date.now()): { status: DeploymentStatus; daysLeft: number | null } {
  if (type === "FREE") return { status: "free", daysLeft: null };
  if (!validUntil) return { status: "active", daysLeft: null };
  const exp = Date.parse(validUntil); if (!Number.isFinite(exp)) return { status: "active", daysLeft: null };
  const days = utcDay(exp) - utcDay(now);
  if (now >= exp) return { status: "expired", daysLeft: Math.min(days, -1) };
  return { status: days <= EXPIRING_DAYS ? "expiring" : "active", daysLeft: days };
}

export const needsAttention = (s: DeploymentStatus) => s === "expiring" || s === "expired";

/** The limits in force: the recorded licence while it is valid, FREE otherwise (expired, or a FREE box). */
export const effectiveLimits = (type: string, limits: DeploymentLimits, status: DeploymentStatus): DeploymentLimits => (type === "FREE" || status === "expired" ? FREE_LIMITS : limits);

/** AT LIMIT when used equals the limit, OVER LIMIT when above it, null limit = unlimited = always ok. */
export const usageFlag = (used: number, limit: number | null): UsageFlag => (limit === null ? "ok" : used > limit ? "over_limit" : used === limit ? "at_limit" : "ok");

/** Percent of the term used (0..100), or null without both dates. */
export function termPct(issuedAt: string | null, validUntil: string | null, now = Date.now()): number | null {
  if (!issuedAt || !validUntil) return null;
  const a = Date.parse(issuedAt), b = Date.parse(validUntil); if (!(b > a)) return null;
  return Math.max(0, Math.min(100, Math.round(((now - a) / (b - a)) * 100)));
}

/** Expiry ascending, no expiry (and FREE) last, then name. */
export function sortByExpiry<T extends { validUntil: string | null; name: string }>(a: T[]): T[] {
  return [...a].sort((x, y) => (x.validUntil ?? "9999").localeCompare(y.validUntil ?? "9999") || x.name.localeCompare(y.name));
}
