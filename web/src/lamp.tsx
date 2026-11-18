// 2026-11-19 -- Shape lamps for Server Connection and Connected Boxes. Shape AND word AND colour, never colour alone (UI spec): circle = healthy, triangle = attention, square = fault, ring = not active.
import type { ReactNode } from "react";
export type Shape = "circle" | "triangle" | "square" | "ring";
export type LampTone = "ok" | "warn" | "alarm" | "off";
export function ShapeLamp({ shape, size = 14 }: { shape: Shape; size?: number }) {
  return <svg className="sl-lamp" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    {shape === "circle" && <circle cx="9" cy="9" r="7" fill="currentColor" />}{shape === "triangle" && <path d="M9 2 L17 16 H1 Z" fill="currentColor" />}
    {shape === "square" && <rect x="2" y="2" width="14" height="14" fill="currentColor" />}{shape === "ring" && <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" />}</svg>;
}
/** Lamp plus word, coloured by tone. */
export const Status = ({ shape, tone, children, size }: { shape: Shape; tone: LampTone; children: ReactNode; size?: number }) => <span className="sl-st" data-tone={tone}><ShapeLamp shape={shape} size={size} />{children}</span>;

export type LinkState = "CONNECTED" | "CONNECTING" | "NOT_REACHABLE" | "NOT_ENROLLED" | "DISABLED";
export const LINK: Record<LinkState, { shape: Shape; tone: LampTone; word: string }> = {
  CONNECTED: { shape: "circle", tone: "ok", word: "CONNECTED" }, CONNECTING: { shape: "triangle", tone: "warn", word: "CONNECTING" }, NOT_REACHABLE: { shape: "square", tone: "alarm", word: "NOT REACHABLE" },
  NOT_ENROLLED: { shape: "ring", tone: "off", word: "NOT ENROLLED" }, DISABLED: { shape: "ring", tone: "off", word: "DISABLED" } };
export type BoxStatus = "ONLINE" | "LATE" | "OFFLINE" | "NOT_ENROLLED" | "REVOKED";
export const BOX: Record<BoxStatus, { shape: Shape; tone: LampTone; word: string }> = {
  ONLINE: { shape: "circle", tone: "ok", word: "ONLINE" }, LATE: { shape: "triangle", tone: "warn", word: "LATE" }, OFFLINE: { shape: "square", tone: "alarm", word: "OFFLINE" },
  NOT_ENROLLED: { shape: "ring", tone: "off", word: "NOT ENROLLED" }, REVOKED: { shape: "ring", tone: "off", word: "REVOKED" } };
