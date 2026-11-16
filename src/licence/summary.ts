// The licence part of /api/about. FREE until a licence is installed (Step 2 of the About work replaces `freeSummary` with the real service, same shape).
import type { Db } from "../db.js";
import { FREE_LICENCE } from "./free.js";
import { usage, type Usage } from "./usage.js";

export type LicenceState = "FREE" | "LICENSED" | "EXPIRED" | "INVALID";
export interface LicenceSummary { type: string; licensed_to: string | null; valid_until: string | null; state: LicenceState; limits: Usage; usage: Usage; over_limit: boolean; reason?: string; }
export const overLimit = (u: Usage, l: Usage) => u.sensors > l.sensors || u.gateways > l.gateways;
export function freeSummary(db: Db): LicenceSummary {
  const limits = { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors }, u = usage(db);
  return { type: FREE_LICENCE.type, licensed_to: null, valid_until: null, state: "FREE", limits, usage: u, over_limit: overLimit(u, limits) };
}
