import mqtt from "mqtt";
import { config } from "./config.js";
import { openDb, getSetting } from "./db.js";
import { AedesBroker } from "./broker.js";
import { Ingest } from "./ingest.js";
import { Commands, ackTopic, PUMPS } from "./commands.js";
import { ensureAdmin, purgeSessions } from "./auth.js";
import { runRetention, runRollup } from "./retention.js";
import { buildApp } from "./app.js";

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

const { app, pushTelemetry: pt, pushCommand: pc } = await buildApp(db, ingest, commands);
pushTelemetry = pt; pushCommand = pc;
await app.listen({ host: config.host, port: config.port });

const timers = [
  setInterval(() => commands.sweep(), 1000),
  setInterval(() => { try { runRollup(db); purgeSessions(db); } catch (e) { console.error("rollup", e); } }, 10 * 60_000),
  setInterval(() => { runRetention(db, config.retentionDays).then((n) => n && console.log(`retention removed ${n} raw rows`)).catch((e) => console.error("retention", e)); }, 6 * 3600_000),
];
setTimeout(() => runRetention(db, config.retentionDays).catch((e) => console.error("retention", e)), 30_000);

let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; timers.forEach(clearInterval);
  await app.close(); client.end(true); await broker.stop(); db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); process.exit(0);
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
void getSetting;
