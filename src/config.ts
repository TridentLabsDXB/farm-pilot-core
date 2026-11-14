// FARM-PILOT CORE -- runtime configuration, all from environment (systemd EnvironmentFile). No file is ever required.
const env = process.env;
const int = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && env[k] !== undefined && env[k] !== "" ? n : d; };

export const config = {
  host: env.HOST_BIND_IP || "127.0.0.1",
  port: int("PORT", 4100),
  dbPath: env.DB_PATH || "/var/lib/farmpilot-core/core.db",
  dataDir: env.DATA_DIR || "/var/lib/farmpilot-core",
  mqttHost: "127.0.0.1",                    // loopback ONLY, never configurable to a public address
  mqttPort: int("MQTT_PORT", 1884),         // 1883 is EMQX on the test bench
  farm: env.FARM_SLUG || "demo-farm",
  // Session cookie Secure flag: "true" | "false" | "auto". auto = Secure only when the request came over HTTPS
  // (X-Forwarded-Proto from NPM). On the real box the hotspot serves plain HTTP, where a Secure cookie would break login.
  cookieSecure: (env.COOKIE_SECURE || "auto").toLowerCase(),
  trustProxy: (env.TRUST_PROXY ?? "true") !== "false",
  retentionDays: int("RETENTION_DAYS", 30),
  commandTimeoutSec: int("COMMAND_TIMEOUT_SEC", 10),   // default only; Admin can change it in Settings
  dedupeWindowMs: int("COMMAND_DEDUPE_MS", 3000),
  sessionHours: int("SESSION_HOURS", 12),
};
