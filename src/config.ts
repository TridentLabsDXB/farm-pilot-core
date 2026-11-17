// FARM-PILOT CORE -- runtime configuration, all from environment (systemd EnvironmentFile). No file is ever required.
import { join } from "node:path";
const env = process.env;
const int = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && env[k] !== undefined && env[k] !== "" ? n : d; };

export const config = {
  host: env.HOST_BIND_IP || "127.0.0.1",
  port: int("PORT", 4100),
  // 2026-11-17 -- DB_PATH defaults to <DATA_DIR>/core.db. It used to default to /var/lib/farmpilot-core/core.db whatever DATA_DIR said, so a throwaway instance started with only DATA_DIR
  // opened the LIVE bench database (docs/ops-notes.md, audit row 373). Set DB_PATH explicitly only to put the database somewhere else than the data folder.
  dbPath: env.DB_PATH || join(env.DATA_DIR || "/var/lib/farmpilot-core", "core.db"),
  dataDir: env.DATA_DIR || "/var/lib/farmpilot-core",
  mqttHost: "127.0.0.1",                    // loopback ONLY, never configurable to a public address
  mqttPort: int("MQTT_PORT", 1884),         // 1883 is EMQX on the test bench
  farm: env.FARM_SLUG || "demo-farm",
  // Session cookie Secure flag: "true" | "false" | "auto". auto = Secure only when the request came over HTTPS
  // (X-Forwarded-Proto from NPM). On the real box the hotspot serves plain HTTP, where a Secure cookie would break login.
  cookieSecure: (env.COOKIE_SECURE || "auto").toLowerCase(),
  trustProxy: (env.TRUST_PROXY ?? "true") !== "false",
  // History retention. NORMALLY the licence decides (FREE 90 days, licence v2 as signed, null = never prune; see licence/range.ts). RETENTION_DAYS is an operator override and wins when set.
  retentionDays: (env.RETENTION_DAYS ?? "") !== "" && Number.isFinite(Number(env.RETENTION_DAYS)) ? Number(env.RETENTION_DAYS) : (null as number | null),
  exportMaxRows: int("EXPORT_MAX_ROWS", 500_000),   // CSV export refuses a request that would write more rows than this (choose a shorter range or one zone)
  commandTimeoutSec: int("COMMAND_TIMEOUT_SEC", 10),   // default only; Admin can change it in Settings
  dedupeWindowMs: int("COMMAND_DEDUPE_MS", 3000),
  sessionHours: int("SESSION_HOURS", 12),
  // Milestone 2 gateway (XZ-DS-MUS2). GW_TRANSPORT unset or "off" = no gateway polling (the runtime behaves as in Milestone 1).
  gwTransport: (env.GW_TRANSPORT || "off") as "off" | "tcp" | "rtu-tcp" | "rtu-serial",
  gwHost: env.GW_HOST || "127.0.0.1", gwPort: int("GW_PORT", 5020), gwSerialPath: env.GW_SERIAL_PATH || "/dev/ttyUSB0", gwBaud: int("GW_BAUD", 9600),
  gwParity: (env.GW_PARITY || "none") as "none" | "even" | "odd", gwAddress: int("GW_ADDRESS", 0), gwTimeoutMs: int("GW_TIMEOUT_MS", 1500), gwRetries: int("GW_RETRIES", 2),
  // 2026-11-17 -- ONLINE build (the VPS / bench, not a standalone box). FP_ONLINE=1 adds Licence Management (SYSTEM menu, #/licences, /api/licence-deployments, two tables). Unset = standalone: none of it exists.
  online: ["1", "true", "yes"].includes((env.FP_ONLINE ?? "").toLowerCase()),
  gwRegmap: env.GW_REGMAP || "config/gateway-thingsend.yaml",
};
