// Bench acceptance run against a RUNNING core + gateway simulator (dev instance or the bench). Usage:
//   BASE=http://127.0.0.1:4110 CTL=http://127.0.0.1:15030 USER=devadmin PASS=... node scripts/acceptance.mjs
// Uses interval 10 s so "no update" appears quickly. Leaves the sensors in place; run it on a scratch database.
const BASE = process.env.BASE, CTL = process.env.CTL, U = process.env.USER_NAME || process.env.USER, P = process.env.PASS, OPU = process.env.OP_USER, OPP = process.env.OP_PASS;
let cookie = ""; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let fails = 0;
const api = async (m, p, b) => { const r = await fetch(BASE + "/api" + p, { method: m, headers: { "content-type": "application/json", cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return { status: r.status, body: await r.json().catch(() => ({})) }; };
const ctl = (p) => fetch(CTL + p, { method: "POST" }).then((r) => r.json());
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const SERIALS = ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6", "4A01B3F7", "4A01B3F8", "4A01B3F9"];

check("login", (await api("POST", "/login", { username: U, password: P })).status === 200);
check("add 8 T/H serials", (await api("POST", "/sensors", { type: "th", serials: SERIALS })).status === 200);
check("duplicate rejected", (await api("POST", "/sensors", { type: "th", serials: [SERIALS[0]] })).status === 400);
for (const s of SERIALS) await api("PATCH", `/sensors/${s}`, { interval: 10 });
let r = await api("POST", "/gateway/sync", { types: ["th"] });
check("Send to Gateway: all confirmed", r.status === 200 && r.body[0].items.length === 8 && r.body[0].items.every((i) => i.status === "confirmed"), JSON.stringify(r.body[0]?.items?.map((i) => i.status)));
await api("PATCH", `/sensors/${SERIALS[1]}`, { interval: 30 });
r = await api("POST", "/gateway/sync/plan", { type: "th" }); check("interval change plans exactly one write", r.body.writes.length === 1 && r.body.writes[0].reason === "interval");
r = await api("POST", "/gateway/sync", { types: ["th"] }); check("interval change confirmed", r.body[0].ok);
await api("POST", "/zones", { name: "Greenhouse 1", type: "climate" }); await api("POST", "/zones", { name: "Greenhouse 2", type: "climate" });
const z = (await api("GET", "/structure")).body.zones; for (const [i, s] of SERIALS.entries()) await api("POST", "/zones/assign", { serial: s, zoneId: z[i < 4 ? 0 : 1].id });
console.log("waiting 25 s for readings..."); await sleep(25000);
let d = (await api("GET", `/sensors/${SERIALS[0]}`)).body; const raw = d.sensor.raw.temperature;
check("live values present (raw, voltage, rssi)", typeof raw === "number" && d.sensor.voltage > 3 && d.sensor.rssi < -50, `raw=${raw} V=${d.sensor.voltage} rssi=${d.sensor.rssi}`);
r = await api("POST", `/sensors/${SERIALS[0]}/calibrate`, { metric: "temperature", method: "offset", raw, reference: raw - 0.5 }); check("calibrate with reference", r.status === 200 && r.body.cal.offset === -0.5);
r = await api("POST", `/sensors/${SERIALS[0]}/calibrate`, { metric: "temperature", method: "offset", raw, reference: raw + 9 }); check("out-of-limit calibration refused", r.status === 409);
await sleep(15000);
let v = (await api("GET", "/scada")).body; const s0 = v.zones[0].sensors.find((s) => s.label === SERIALS[0]);
check("SCADA built from structure: 2 zones with sensors", v.zones.length === 2 && v.zones.every((x) => x.sensors.length === 4));
check("SCADA shows calibrated value", s0.temperature !== undefined && Math.abs(s0.temperature - ((await api("GET", `/sensors/${SERIALS[0]}`)).body.sensor.raw.temperature - 0.5)) < 1, `cal=${s0.temperature}`);
if (OPU) { const adm = cookie; await api("POST", "/login", { username: OPU, password: OPP }); const ov = (await api("GET", "/scada")).body.zones[0].sensors[0]; check("operator view hides serial/raw/slot", ov.serial === undefined && ov.raw === undefined && ov.slot === undefined); check("operator cannot reach setup", (await api("GET", "/sensors")).status === 403 && (await api("POST", "/gateway/sync", {})).status === 403); cookie = adm; }
console.log("freezing", SERIALS[2], "..."); await ctl(`/freeze?serial=${SERIALS[2]}`); await sleep(50000);
v = (await api("GET", "/scada")).body; check("frozen sensor -> NO UPDATE within 3 intervals", v.zones[0].sensors.find((s) => s.label === SERIALS[2]).status === "no_update" && v.alarms.some((a) => a.kind === "no_update"));
console.log("stopping gateway ..."); await ctl("/stop"); await sleep(50000);
v = (await api("GET", "/scada")).body; check("gateway offline shown; sensors unknown; core alive", !v.gateway.online && v.alarms[0].kind === "gateway_offline" && v.zones[0].sensors.every((s) => s.status === "unknown"));
await ctl("/start"); await sleep(40000); v = (await api("GET", "/scada")).body; check("gateway back online", v.gateway.online);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
