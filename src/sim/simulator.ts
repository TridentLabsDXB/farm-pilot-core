// DEV / TEST BENCH ONLY. Never installed on the real box image (see deploy/install-sim.sh, not part of deploy.sh).
// Plays the part of the PLC + sensors: publishes Demo-Farm-style Unified payloads and echoes pump commands with an acknowledgement.
// It connects ONLY to the embedded broker on loopback.
import mqtt from "mqtt";

const FARM = process.env.FARM_SLUG || "demo-farm";
const PORT = Number(process.env.MQTT_PORT || 1884);
const EVERY_MS = Number(process.env.SIM_INTERVAL_MS || 5000);
const ACK_DELAY_MS = Number(process.env.SIM_ACK_DELAY_MS || 600);
const NO_ACK = process.env.SIM_NO_ACK === "1";        // test the timeout state
const MAX_CMD_AGE_MS = 15_000;                         // a PLC must not act on an old command

const c = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: "core-sim", reconnectPeriod: 1000 });
const pump = { on: false };
const r = (base: number, amp: number, period: number, dp = 1) => +(base + amp * Math.sin(Date.now() / 1000 / period) + (Math.random() - 0.5) * amp * 0.1).toFixed(dp);
const pub = (zone: string, sensors: unknown[]) => c.publish(`farmpilot/${FARM}/${zone}`, JSON.stringify({ ts: new Date().toISOString(), sensors }), { qos: 0 });

function publishAll() {
  pub("air", [{ key: "AIR1", type: "temp_humidity", readings: { temp: r(27, 4, 600), humidity: r(55, 12, 900), co2: r(520, 80, 1200, 0) } }]);
  pub("soil", [{ key: "SOIL1", type: "soil", readings: { moisture: r(38, 6, 1500), temp: r(23, 1.5, 1800), ec: r(1.8, 0.3, 2000, 2) } }]);
  pub("water", [{ key: "WATER1", type: "water", readings: { level: r(72, 8, 1100, 0), ph: r(6.2, 0.3, 1700, 2), flow: pump.on ? r(18, 1.5, 30) : 0 } },
                { key: "WPump1", type: "pump", readings: { status: pump.on ? 1 : 0 } }]);
}

c.on("connect", () => { console.log("sim connected"); c.subscribe(`farmpilot/${FARM}/cmd/+`, { qos: 1 }); publishAll(); });
c.on("message", (topic, buf) => {
  let m: any; try { m = JSON.parse(buf.toString()); } catch { return; }
  const pumpName = topic.split("/").pop()!;
  if (pumpName !== "pump1" || typeof m.cmd_id !== "string" || (m.action !== "on" && m.action !== "off")) return;
  if (Date.now() - Number(m.ts) > MAX_CMD_AGE_MS) { console.log("ignored stale command", m.cmd_id); return; }
  if (NO_ACK) { console.log("NO_ACK: dropping", m.cmd_id); return; }
  setTimeout(() => {
    pump.on = m.action === "on"; console.log("pump1", m.action, m.cmd_id);
    c.publish(`farmpilot/${FARM}/ack/${pumpName}`, JSON.stringify({ cmd_id: m.cmd_id, ok: true, state: m.action, ts: Date.now() }), { qos: 1 });
    publishAll();
  }, ACK_DELAY_MS);
});
setInterval(() => { if (c.connected) publishAll(); }, EVERY_MS);
