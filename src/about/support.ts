// Diagnostics (COPY DIAGNOSTICS) and the support bundle. ADMIN ONLY. Secrets never go in: the config is an ALLOW-list (a new setting is excluded until someone adds it here), settings are an allow-list of prefixes,
// logs are sanitised when stored (logbuf.ts), and the bundle never reads the data folder, the users table or the sessions table.
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { audit, type Db } from "../db.js";
import type { GatewayService } from "../gateway/service.js";
import type { ProfileService } from "../gateway/profile.js";
import type { PortManager } from "../ports/manager.js";
import { freeSummary, type LicenceSummary } from "../licence/summary.js";
import { thisDeviceId } from "../licence/device.js";
import { loadBranding } from "./branding.js";
import { readBuild } from "./build.js";
import { computerInfo, listSerialNames } from "./host.js";
import { recentErrors, recentLines, sanitizeLine } from "./logbuf.js";
import { makeZip } from "./zip.js";

/** Config keys that may appear in diagnostics. Every key of `config` must be listed here or in CONFIG_EXCLUDED (a test enforces it). */
export const CONFIG_SHOWN = ["host", "port", "dbPath", "dataDir", "logsDir", "mqttPort", "farm", "cookieSecure", "trustProxy", "retentionDays", "commandTimeoutSec", "dedupeWindowMs", "sessionHours", "gwTransport", "gwHost", "gwPort", "gwSerialPath", "gwBaud", "gwParity", "gwAddress", "gwTimeoutMs", "gwRetries", "gwRegmap"] as const;
export const CONFIG_EXCLUDED = ["mqttHost"] as const;                  // loopback constant, no information
const SECRET_NAME = /secret|token|pass|hash|key|cookie|credential/i;       // belt and braces: even an allowed prefix never exports a secret-looking name
const SETTING_PREFIXES = ["gw.", "cal.", "command_timeout_sec", "backup.", "slots_1based", "serial_decimal_minutes"];

export interface SupportDeps { db: Db; admin: any; prof: ProfileService; licence?: () => LicenceSummary; deviceId?: () => string | null; ports?: PortManager | null; gw?: GatewayService | null; serialPorts?: () => Promise<string[]>; }

export function sanitizedConfig(): Record<string, unknown> { const o: Record<string, unknown> = {}; for (const k of CONFIG_SHOWN) if (k in config) o[k] = (config as any)[k]; return o; }
export function sanitizedSettings(db: Db): Record<string, string> {
  const o: Record<string, string> = {}; for (const r of db.prepare("SELECT key,value FROM settings ORDER BY key").all() as { key: string; value: string }[]) if (SETTING_PREFIXES.some((p) => r.key === p || r.key.startsWith(p)) && !SECRET_NAME.test(r.key)) o[r.key] = sanitizeLine(r.value);
  return o;
}
/** Plain description of every port and device (no secrets exist there; the view is the same one the RS-485 Ports page shows to an Admin). */
export function portsAndDevices(ports: PortManager | null | undefined) { if (!ports) return { enabled: false }; const v: any = ports.view(); return { ports: v.ports, devices: v.devices }; }

export async function buildDiagnostics(d: SupportDeps) {
  const b = readBuild(), licence = (d.licence ?? (() => freeSummary(d.db)))();
  const computer = await computerInfo(d.db, { dataDir: config.dataDir, dbPath: config.dbPath, timezone: d.prof.publicInfo().timezone }, { serialPorts: d.serialPorts ?? (() => listSerialNames()) });
  const g = d.gw;
  return {
    generated_at: new Date().toISOString(), product: loadBranding().product_name, version: b.version, build: b.build, released: b.released, label: b.label,
    device_id: (d.deviceId ?? (() => thisDeviceId()))(), host: computer, licence: { ...licence }, core_uptime_s: Math.round(process.uptime()),
    ports: d.ports ? (portsAndDevices(d.ports) as any).ports?.map((p: any) => ({ id: p.id, label: p.label, enabled: p.enabled, status: p.status, transport: p.transport, device_path: p.device_path, tcp_host: p.tcp_host, tcp_port: p.tcp_port, lastError: p.lastError ?? null, counters: p.counters })) ?? [] : [],
    gateway_link: g ? { enabled: g.enabled, online: g.online, last_ok: g.lastOk, last_error: g.lastError } : { enabled: false, online: false, last_ok: null, last_error: null },
    last_errors: recentErrors(),
  };
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "farm";
export async function buildSupportBundle(d: SupportDeps, now = new Date()): Promise<{ name: string; data: Buffer }> {
  const diag = await buildDiagnostics(d), farm = slug(d.prof.farmName() || config.farm), date = now.toISOString().slice(0, 10);
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  const files = [
    { name: "README.txt", data: "FARM-PILOT CORE support bundle.\n\ndiagnostics.json   versions, host, licence state and usage, ports, gateway link, last errors\nconfig.json        sanitised configuration and settings (no passwords, tokens or session secrets)\nports-and-devices.json  RS-485 ports and bus devices\nlicence.json       licence state and usage (the licence file itself is not included)\nlogs/recent.log    the most recent log lines, with cookies, tokens and passwords removed\n\nGenerated " + now.toISOString() + "\n" },
    { name: "diagnostics.json", data: json(diag) }, { name: "config.json", data: json({ config: sanitizedConfig(), settings: sanitizedSettings(d.db), farm_slug: config.farm }) },
    { name: "ports-and-devices.json", data: json(portsAndDevices(d.ports)) }, { name: "licence.json", data: json({ device_id: diag.device_id, ...diag.licence }) },
    { name: "logs/recent.log", data: recentLines().join("\n") + "\n" },
  ];
  return { name: `farmpilot-core-support-${farm}-${date}.zip`, data: makeZip(files, now) };
}

export function registerSupportRoutes(app: FastifyInstance, d: SupportDeps) {
  app.get("/api/diagnostics", { preHandler: d.admin }, async () => buildDiagnostics(d));
  app.get("/api/support-bundle", { preHandler: d.admin }, async (req, reply) => {
    const z = await buildSupportBundle(d); audit(d.db, (req as any).user.username, "admin", "support.bundle", { file: z.name, bytes: z.data.length });
    reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${z.name}"`).header("cache-control", "no-store"); return z.data;
  });
}
