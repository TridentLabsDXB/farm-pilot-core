// 2026-11-17 -- licence v2 helpers for the web app: null limit = unlimited, ENGINEERING shows as "ENGINEERING LICENCE".
import type { LicenceInfo } from "./api";
export const ENGINEERING = "ENGINEERING";
export const limitWord = (n: number | null) => (n === null ? "unlimited" : String(n));
export const atOrOver = (used: number, limit: number | null) => limit !== null && used >= limit;
export const wouldExceed = (used: number, add: number, limit: number | null) => limit !== null && used + add > limit;
/** What the licence is called on screen: the type, except ENGINEERING which reads "ENGINEERING LICENCE" (never "PRO"). */
export const licWord = (l: Pick<LicenceInfo, "state" | "type">) => (l.state === "LICENSED" ? (l.type === ENGINEERING ? "ENGINEERING LICENCE" : l.type) : l.state);
export const isEngineering = (l: Pick<LicenceInfo, "state" | "type"> | null | undefined) => !!l && l.state === "LICENSED" && l.type === ENGINEERING;
