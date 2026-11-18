import mqtt from "mqtt";
import { config } from "./config.js";
import { openDb, getSetting } from "./db.js";
import { AedesBroker } from "./broker.js";
import { Ingest } from "./ingest.js";
import { Commands, ackTopic, PUMPS } from "./commands.js";
import { ensureAdmin, purgeFails, purgeSessions } from "./auth.js";
import { runLicenceRetention, runRollup } from "./retention.js";
import { buildApp } from "./app.js";
import { loadRegMap } from "./drivers/modbus/regmap.js";
import { Registry } from "./gateway/registry.js";
import { GatewayService } from "./gateway/service.js";
import { PortStore } from "./ports/store.js";
import { PortManager } from "./ports/manager.js";
import { isWin, shutdownSignals } from "./platform.js";
import { installLogCapture } from "./about/logbuf.js";
import { LicenceService } from "./licence/service.js";
import { MqttSourceService } from "./mqtt/service.js";
import { PlcService } from "./plc/service.js";
import { A100Service } from "./a100/service.js";
import { VboxSource } from "./vbox/service.js";
import { ServerLink } from "./serverlink/client.js";
import { readBuild } from "./about/build.js";
import { osName } from "./about/host.js";
import { thisDeviceId } from "./licence/device.js";

installLogCapture();                       // keeps a sanitised copy of the last log lines for diagnostics (about/logbuf.ts)
console.log(`database: ${config.dbPath} (data folder: ${config.dataDir})`);       // the resolved path, so a wrong DATA_DIR / DB_PATH is visible in the first log line
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
{ const fixed = portStore.repairDeviceFlags(); if (fixed) console.log(`RS-485 ports: switched ${fixed} bus device(s) ON (they were seeded OFF with no way to change it); the port's Enabled flag decides what is opened`); }
const ports = new PortManager(db, portStore, map, gw);
await ports.start();
const lic = new LicenceService(db);       // FREE until a licence is installed; re-read now and every 24 h (expiry is also checked live on every use)
// MQTT Payload source: connects only when an Admin enabled it; a broker that is down never blocks start-up (it reconnects with backoff in the background).
const mqttSrc = new MqttSourceService(db, ingest);
const vboxSrc = new VboxSource(db, ingest, lic), plcSrc = new PlcService(db, ingest, lic, () => ports);
mqttSrc.attachVbox(vboxSrc);
mqttSrc.start(); plcSrc.start();
const a100Src = new A100Service(db, () => ports); a100Src.start(); const a100Sweep = setInterval(() => a100Src.sweep(), 5000); a100Sweep.unref();
// 2026-11-19: Server Connection. Off until an Admin enables and enrols it. start() only arms a timer: it is never awaited, and nothing it does can block the lines above or below (serverlink/client.ts, ISOLATION).
const serverLink = new ServerLink({ db, licence: () => lic.summary(), deviceId: () => thisDeviceId(), version: () => { const b = readBuild(); return { version: b.version, build: b.build }; }, os: () => osName(), defaultName: () => { try { return String((db.prepare("SELECT farm_name n FROM farm_profile WHERE id=1").get() as { n: string } | undefined)?.n ?? "FARM-PILOT CORE"); } catch { return "FARM-PILOT CORE"; } } });
const { app, pushTelemetry: pt, pushCommand: pc } = await buildApp(db, ingest, commands, reg, gw, gwError, ports, lic, { mqtt: mqttSrc, plc: plcSrc, vbox: vboxSrc, a100: a100Src, link: serverLink });
pushTelemetry = pt; pushCommand = pc;
await app.listen({ host: config.host, port: config.port });
serverLink.start();

const timers = [
  setInterval(() => commands.sweep(), 1000),
  setInterval(() => { try { lic.refresh(); } catch (e) { console.error("licence check", e); } }, 24 * 3600_000),
  setInterval(() => { try { runRollup(db); purgeSessions(db); purgeFails(db); } catch (e) { console.error("rollup", e); } }, 10 * 60_000),
  setInterval(() => { runLicenceRetention(db, lic).then((n) => n && console.log(`retention removed ${n} history rows`)).catch((e) => console.error("retention", e)); }, 6 * 3600_000),
];
setTimeout(() => runLicenceRetention(db, lic).catch((e) => console.error("retention", e)), 30_000);

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; if (isWin()) setTimeout(() => process.exit(1), 15_000).unref(); timers.forEach(clearInterval);
  serverLink.stop(); a100Src.stop(); await mqttSrc.stop(); await plcSrc.stop(); await ports.stop(); await gw?.stop(); await app.close(); client.end(true); await broker.stop(); db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); process.exit(0);
}
// Windows (W1): there is no SIGTERM. Ctrl+C = SIGINT, Ctrl+Break and a service stop wrapper (NSSM/WinSW send Ctrl+C first) = SIGINT/SIGBREAK, closing the console = SIGHUP.
// A 15 s guard makes sure a hung close cannot keep the process alive. WAL is crash-safe, so a hard kill still loses nothing already committed.
for (const sig of shutdownSignals()) process.on(sig, shutdown);
void getSetting;
