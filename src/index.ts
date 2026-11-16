import mqtt from "mqtt";
import { config } from "./config.js";
import { openDb, getSetting } from "./db.js";
import { AedesBroker } from "./broker.js";
import { Ingest } from "./ingest.js";
import { Commands, ackTopic, PUMPS } from "./commands.js";
import { ensureAdmin, purgeFails, purgeSessions } from "./auth.js";
import { runRetention, runRollup } from "./retention.js";
import { buildApp } from "./app.js";
import { loadRegMap } from "./drivers/modbus/regmap.js";
import { Registry } from "./gateway/registry.js";
import { GatewayService } from "./gateway/service.js";
import { PortStore } from "./ports/store.js";
import { PortManager } from "./ports/manager.js";
import { installLogCapture } from "./about/logbuf.js";
import { LicenceService } from "./licence/service.js";

installLogCapture();                       // keeps a sanitised copy of the last log lines for diagnostics (about/logbuf.ts)
const db = openDb(config.dbPath);
ensureAdmin(db);
const broker = new AedesBroker(config.mqttPort, config.mqttHost);
await broker.start();

const client = mqtt.connect(`mqtt://${config.mqttHost}:${config.mqttPort}`, { clientId: "core-runtime", reconnectPeriod: 1000, clean: true });
const ingest = new Ingest(db);
let pushTelemetry: (t: any) => void = () => {}, pushCommand: (c: any) => void = () => {};
const commands = new Commands(db, client, (c) => pushCommand(c));
commands.closeStaleOnBoot();               // never re-send: stale 'sent' commands are closed as timeout

client.on("connect", () => {
  client.subscribe([`farmpilot/${config.farm}/+`, ...PUMPS.map((p) => ackTopic(p))], { qos: 1 });
});
client.on("message", (topic, payload) => {
  try {
    if (topic.includes("/ack/")) commands.onAck(payload);
    else { const t = ingest.handle(topic, payload); if (t) pushTelemetry(t); }
  } catch (e) { console.error("message error", topic, e); }
});

// Gateway: an invalid register map refuses to start polling (clear error) but never takes the rest of the runtime down.
// The serial link is no longer built from the environment file: Port 1 / Port 2 and the device assignment live in the database (Settings > RS-485 Ports).
// On the FIRST start the old GW_* values are migrated into Port 1 + the LoRa Sensor Gateway device, so a running box changes nothing.
let reg: Registry | null = null, gw: GatewayService | null = null, gwError: string | null = null, map: ReturnType<typeof loadRegMap> | null = null;
try {
  map = loadRegMap(config.gwRegmap);
  reg = new Registry(db, map);
  gw = new GatewayService(db, reg, ingest, null);
  gw.start();
} catch (e: any) { gwError = String(e?.message ?? e); reg = null; gw = null; console.error("GATEWAY DISABLED, register map problem:", gwError); }
const portStore = new PortStore(db);
if (portStore.migrateFromEnv({ transport: config.gwTransport, host: config.gwHost, port: config.gwPort, serialPath: config.gwSerialPath, baud: config.gwBaud, parity: config.gwParity, address: config.gwAddress, timeoutMs: config.gwTimeoutMs, retries: config.gwRetries }, map?.default_gateway_address ?? 1))
  console.log("RS-485 ports: migrated the gateway link settings from the environment into Port 1");
const ports = new PortManager(db, portStore, map, gw);
await ports.start();
const lic = new LicenceService(db);       // FREE until a licence is installed; re-read now and every 24 h (expiry is also checked live on every use)
const { app, pushTelemetry: pt, pushCommand: pc } = await buildApp(db, ingest, commands, reg, gw, gwError, ports, lic);
pushTelemetry = pt; pushCommand = pc;
await app.listen({ host: config.host, port: config.port });

const timers = [
  setInterval(() => commands.sweep(), 1000),
  setInterval(() => { try { lic.refresh(); } catch (e) { console.error("licence check", e); } }, 24 * 3600_000),
  setInterval(() => { try { runRollup(db); purgeSessions(db); purgeFails(db); } catch (e) { console.error("rollup", e); } }, 10 * 60_000),
  setInterval(() => { runRetention(db, config.retentionDays).then((n) => n && console.log(`retention removed ${n} raw rows`)).catch((e) => console.error("retention", e)); }, 6 * 3600_000),
];
setTimeout(() => runRetention(db, config.retentionDays).catch((e) => console.error("retention", e)), 30_000);

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; timers.forEach(clearInterval);
  await ports.stop(); await gw?.stop(); await app.close(); client.end(true); await broker.stop(); db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
void getSetting;
