// 2026-11-16 -- CONTROL: device list type and the ONE place that turns live telemetry into a device state.
// CONTROL (ControlCard) and the SCADA control status line both call deviceState() with the same `state` object that App already keeps up to date
// from /api/state and the WebSocket, so SCADA never polls separately and the two screens cannot disagree.
import type { State } from "./api";

export type ControlKind = "pump" | "fan" | "valve" | "actuator" | "other";
export interface ControlDevice { id: string; kind: ControlKind; role: string | null; name: string; zoneId: number | null; capabilities: string[]; feedback: { topic: string; sensor: string; reading: string } | null; }
export type DeviceState = "on" | "off" | "unknown";
export const STALE_MS = 30_000;

/** ON / OFF only when the status source is fresh and holds 1 or 0; everything else is UNKNOWN (never guessed from the last command). */
export function deviceState(d: ControlDevice, state: State, now: number): DeviceState {
  const f = d.feedback; if (!f) return "unknown";
  const t = state.topics.find((x) => x.topic === f.topic); const v = t?.sensors.find((x) => x.key === f.sensor)?.readings[f.reading];
  if (!t || now - t.ts > STALE_MS || (v !== 0 && v !== 1)) return "unknown";
  return v === 1 ? "on" : "off";
}

export const GROUPS: { kind: ControlKind[]; title: string }[] = [
  { kind: ["pump"], title: "WATER PUMPS" }, { kind: ["fan"], title: "FANS" }, { kind: ["valve", "actuator"], title: "VALVES AND ACTUATORS" }, { kind: ["other"], title: "OTHER" },
];
const KIND_WORD: Record<ControlKind, string> = { pump: "PUMP", fan: "FAN", valve: "VALVE", actuator: "ACTUATOR", other: "DEVICE" };
export const kindWord = (d: ControlDevice) => KIND_WORD[d.kind];
/** Short label for the SCADA status line: "PUMP" when it is the only one of its kind, else the full name ("EXHAUST FAN 1"). */
export const statusLabel = (d: ControlDevice, all: ControlDevice[]) => (all.filter((x) => x.kind === d.kind).length === 1 ? KIND_WORD[d.kind] : d.name.toUpperCase());

/** Page state of CONTROL: "loading" until the device list answers, "error" when the request failed or timed out (RETRY is shown), else "loaded". Never an endless spinner. */
export type ControlLoad = "loading" | "error" | "loaded";
export const controlLoadState = (devices: ControlDevice[] | null, error: string | null, hasState: boolean): ControlLoad => (error ? "error" : devices && hasState ? "loaded" : "loading");
