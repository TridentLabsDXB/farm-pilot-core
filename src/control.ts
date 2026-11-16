// 2026-11-16 -- CONTROL section: the control_devices definition (change request core-control-section-and-scada-charts.md, sections 2 and 5).
// One entry per device that CONTROL can command. The existing pump is the first one. A new kind (exhaust or mixing fan, valve, actuator) needs
// a `driver` and an entry here, NOT a new page: the web ControlCard and the SCADA control status line are generated from this list.
// Phase 1 keeps the list in code (the pump is fixed on the bench); a config file or table can replace CONTROL_DEVICES later without touching callers.
import { config } from "./config.js";

export type ControlKind = "pump" | "fan" | "valve" | "actuator" | "other";
export type Capability = "on_off" | "speed" | "setpoint";
export interface ControlDevice {
  id: string;                                   // also the MQTT command suffix and commands.pump value (unchanged for the pump: "pump1")
  kind: ControlKind;
  role: string | null;                          // free label, e.g. "exhaust", "mixing"
  name: string;
  zone_id: number | null;                       // null = "No zone"
  driver: "mqtt-onoff";                         // how a command is delivered; only the MQTT on/off driver exists today
  capabilities: Capability[];
  feedback?: { topic: string; sensor: string; reading: string };   // where the running status comes from (Unified payload)
}

export const CONTROL_DEVICES: ControlDevice[] = [
  { id: "pump1", kind: "pump", role: null, name: "Pump 1", zone_id: null, driver: "mqtt-onoff", capabilities: ["on_off"], feedback: { topic: "water", sensor: "WPump1", reading: "status" } },
];

/** Ids that POST /api/commands accepts (only devices with the on_off capability and a command driver). */
export const commandable = () => CONTROL_DEVICES.filter((d) => d.capabilities.includes("on_off")).map((d) => d.id);

/** What every logged-in user (Operator included) receives. No driver, no topics other than the public farmpilot/* status source. */
export const controlView = () => ({
  devices: CONTROL_DEVICES.map((d) => ({ id: d.id, kind: d.kind, role: d.role, name: d.name, zoneId: d.zone_id, capabilities: d.capabilities,
    feedback: d.feedback ? { topic: `farmpilot/${config.farm}/${d.feedback.topic}`, sensor: d.feedback.sensor, reading: d.feedback.reading } : null })),
});
