// 2026-11-18 -- PLC and V-BOX licence gating at RUNTIME (owner decision, core-licence-tiers.md "Feature gating"). The rule itself is tierAllowsPlcVbox (deployments/tiers.ts, one place).
// What this file adds is the lifecycle, behind ONE clearly named function (plcVboxServiceState) because the owner has NOT confirmed it yet:
//   allowed  the licence tier is PRO or higher and valid                      -> create, enable, poll, ingest
//   grace    a real licence was downgraded or expired less than GRACE_DAYS ago -> keeps running, the page shows a warning with the end date
//   stopped  the grace is over (or FREE after a licence)                       -> no polling, no ingest; stored data stays, nothing is deleted, a valid licence restores it at once
//   locked   plain FREE, never licensed                                        -> same as stopped; the page is the locked page
// A licence problem never touches other sources: only these two callers read it.
import { PLC_VBOX_LOCKED_MESSAGE, tierAllowsPlcVbox } from "../deployments/tiers.js";
import type { LicenceSummary } from "./summary.js";
import { HttpError } from "../gateway/registry.js";

export interface DataSourceAccess { tier: string; state: "allowed" | "grace" | "stopped" | "locked"; run: boolean; message: string | null; graceEnds: string | null; }

export function plcVboxServiceState(s: LicenceSummary, now = Date.now()): DataSourceAccess {
  if (s.state === "LICENSED" && tierAllowsPlcVbox(s.type)) return { tier: s.type, state: "allowed", run: true, message: null, graceEnds: null };
  const g = s.grace;                                                    // set while a downgrade grace runs or waits for its prune (licence/service.ts)
  if (g && now < Date.parse(g.delete_on)) return { tier: "FREE", state: "grace", run: true, message: `The licence no longer includes PLC and V-BOX. They keep running until ${g.delete_on.slice(0, 10)}. Upload a licence on the About page.`, graceEnds: g.delete_on };
  if (g) return { tier: "FREE", state: "stopped", run: false, message: "PLC and V-BOX are stopped because the licence ended. Stored data is kept. " + PLC_VBOX_LOCKED_MESSAGE, graceEnds: g.delete_on };
  return { tier: s.state === "LICENSED" ? s.type : "FREE", state: "locked", run: false, message: PLC_VBOX_LOCKED_MESSAGE, graceEnds: null };
}
/** Create / enable / change / test: refused with 403 and the tier message unless the licence allows PLC and V-BOX right now (grace counts as allowed for what is already there, not for NEW sources: see `adding`). */
export function requirePlcVbox(s: LicenceSummary, adding = false, now = Date.now()): DataSourceAccess {
  const a = plcVboxServiceState(s, now);
  if (!a.run || (adding && a.state === "grace")) throw new HttpError(403, PLC_VBOX_LOCKED_MESSAGE, { code: "LICENCE_TIER" });
  return a;
}
