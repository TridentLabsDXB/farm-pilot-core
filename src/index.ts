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
import { createTransport } from "./drivers/modbus/transport.js";
import { ModbusMaster } from "./drivers/modbus/master.js";
import { GatewayDriver } from "./drivers/modbus/driver.js";
import { Registry } from "./gateway/registry.js";
import { GatewayService } from "./gateway/service.js";

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
let reg: Registry | null = null, gw: GatewayService | null = null, gwError: string | null = null;
try {
  const map = loadRegMap(config.gwRegmap);
  reg = new Registry(db, map);
  let drv: GatewayDriver | null = null;
  if (config.gwTransport !== "off") {
    const tr = createTransport({ type: config.gwTransport, host: config.gwHost, port: config.gwPort, path: config.gwSerialPath, baud: config.gwBaud, parity: config.gwParity });
    drv = new GatewayDriver(new ModbusMaster(tr, { unit: config.gwAddress || map.default_gateway_address, timeoutMs: config.gwTimeoutMs, retries: config.gwRetries }), map);
  }
  gw = new GatewayService(db, reg, ingest, drv);
  gw.start();
} catch (e: any) { gwError = String(e?.message ?? e); reg = null; gw = null; console.error("GATEWAY DISABLED, register map problem:", gwError); }
const { app, pushTelemetry: pt, pushCommand: pc } = await buildApp(db, ingest, commands, reg, gw, gwError);
pushTelemetry = pt; pushCommand = pc;
await app.listen({ host: config.host, port: config.port });

const timers = [
  setInterval(() => commands.sweep(), 1000),
  setInterval(() => { try { runRollup(db); purgeSessions(db); purgeFails(db); } catch (e) { console.error("rollup", e); } }, 10 * 60_000),
  setInterval(() => { runRetention(db, config.retentionDays).then((n) => n && console.log(`retention removed ${n} raw rows`)).catch((e) => console.error("retention", e)); }, 6 * 3600_000),
];
setTimeout(() => runRetention(db, config.retentionDays).catch((e) => console.error("retention", e)), 30_000);

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; timers.forEach(clearInterval);
  await gw?.stop(); await app.close(); client.end(true); await broker.stop(); db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
void getSetting;
