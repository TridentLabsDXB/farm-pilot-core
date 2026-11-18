export interface Me { username: string; role: "operator" | "admin"; online?: boolean; }   // online: Online build only (Licence Management); absent on a standalone box
export interface Sensor { key: string; readings: Record<string, number>; }
export interface Topic { topic: string; ts: number; sensors: Sensor[]; }
export interface Cmd { id: string; pump: string; action: "on" | "off"; status: "sent" | "confirmed" | "timeout"; username: string; created_at: number; resolved_at: number | null; note: string | null; }
export interface PublicProfile { farm_name: string; site_name: string; timezone: string; temperature_unit: "C" | "F"; date_format: string; time_format: "12" | "24"; default_theme: "light" | "dark"; logo_url: string | null; }
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
  serial: string; slot: number | null; labelSet: boolean; interval: number; intervalUnit: string; intervalSec: number; offlineAfterSec: number; lowVoltage: number; raw: { temperature?: number; humidity?: number };
  calibrated: boolean; calDueAt: number | null; calibratedAt: number | null; calibratedBy?: string; applying: boolean; intervalOk: boolean; syncState: "in_gateway" | "not_sent" | "changed"; sentInterval: number | null;
}
export interface Alarm { kind: string; severity: "alarm" | "warning"; text: string; serial?: string; since?: number | null; }
export interface ZoneView { id: number; name: string; type: string; status: string; noUpdate: number; lowBattery: number; avgTemperature: number | null; avgHumidity: number | null; reporting: number; total: number; sensors: SensorView[]; }
export interface Scada { commissioning?: { on: boolean; until: number | null }; gateway: { enabled: boolean; online: boolean; lastOk: number | null; model: string }; zones: ZoneView[]; sensors: SensorView[]; alarms: Alarm[]; settings?: { rssiGood: number; rssiPoor: number }; now: number; }
export interface TypeInfo { key: string; label: string; used: number; groups: number; presets: number[]; commissioningPresets: number[]; commissioning: boolean; defaultInterval: number; unit: string; min: number; max: number; models: string[]; }

/** GET /api/about. Operators get everything except device_id and computer. */
export interface LicenceInfo { type: string; licensed_to: string | null; valid_until: string | null; state: "FREE" | "LICENSED" | "EXPIRED" | "INVALID"; limits: { gateways: number | null; sensors: number | null }; reports_days?: number | null; retention_days?: number | null; grace?: { downgrade_at: string; delete_on: string } | null; usage: { gateways: number; sensors: number }; over_limit: boolean; reason?: string; }
export interface ComputerInfo { computer_name: string | null; operating_system: string | null; cpu: string | null; memory_used_bytes: number | null; memory_total_bytes: number | null; disk_free_bytes: number | null; disk_total_bytes: number | null; uptime_s: number | null; ip_addresses: string[] | null; time_zone: string | null; node_version: string | null; sqlite_version: string | null; database_bytes: number | null; serial_ports: string[] | null; data_folder: string | null; platform: string | null; }
export interface AboutInfo { product: string; tagline: string; credit_line: string; support_contact: string; version: string; build: string; released: string | null; label: string; licence: LicenceInfo; uptime_s: number; device_id?: string | null; computer?: ComputerInfo; server_link?: ServerLinkAbout; }

/** GET /api/about, Admin only (an Operator never receives this field). */
export interface ServerLinkAbout { state: "CONNECTED" | "CONNECTING" | "NOT_REACHABLE" | "NOT_ENROLLED" | "DISABLED"; reason: string | null; host: string | null; last_contact_at: number | null; round_trip_ms: number | null; enrolment: string; reports_today: { ok: number; failed: number }; clock_warning: boolean; }
