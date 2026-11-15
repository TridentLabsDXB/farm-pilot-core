export interface Me { username: string; role: "operator" | "admin"; }
export interface Sensor { key: string; readings: Record<string, number>; }
export interface Topic { topic: string; ts: number; sensors: Sensor[]; }
export interface Cmd { id: string; pump: string; action: "on" | "off"; status: "sent" | "confirmed" | "timeout"; username: string; created_at: number; resolved_at: number | null; note: string | null; }
export interface State { farm: string; now: number; topics: Topic[]; commands: Cmd[]; commandTimeoutSec: number; }

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch("/api" + path, { credentials: "same-origin", ...init, headers: init?.json ? { "content-type": "application/json" } : undefined, body: init?.json ? JSON.stringify(init.json) : init?.body });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
  return body as T;
}

/** What an Operator receives (the server sends nothing else to them). */
export interface SensorView { label: string; type: string; status: string; zoneId: number | null; temperature?: number; humidity?: number; voltage?: number; rssi?: number; rssiBand: string; lastChange: number | null; calDue: boolean; checkSensor: boolean; batteryLevel: number; batteryLow: boolean; }
/** Admin-only extras. */
export interface AdminSensor extends SensorView {
  serial: string; slot: number | null; labelSet: boolean; intervalSec: number; offlineAfterSec: number; lowVoltage: number; raw: { temperature?: number; humidity?: number };
  calibrated: boolean; calDueAt: number | null; calibratedAt: number | null; calibratedBy?: string; applying: boolean; intervalOk: boolean; syncState: "in_gateway" | "not_sent" | "changed"; sentInterval: number | null;
}
export interface Alarm { kind: string; severity: "alarm" | "warning"; text: string; serial?: string; since?: number | null; }
export interface ZoneView { id: number; name: string; type: string; status: string; noUpdate: number; lowBattery: number; avgTemperature: number | null; avgHumidity: number | null; reporting: number; total: number; sensors: SensorView[]; }
export interface Scada { commissioning?: { on: boolean; until: number | null }; gateway: { enabled: boolean; online: boolean; lastOk: number | null; model: string }; zones: ZoneView[]; sensors: SensorView[]; alarms: Alarm[]; settings?: { rssiGood: number; rssiPoor: number }; now: number; }
export interface TypeInfo { key: string; label: string; used: number; groups: number; presets: number[]; commissioningPresets: number[]; commissioning: boolean; defaultInterval: number; min: number; max: number; models: string[]; }
