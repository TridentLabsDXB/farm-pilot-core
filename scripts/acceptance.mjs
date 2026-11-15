// Bench acceptance run against a RUNNING core + gateway simulator (dev instance or the bench). Usage:
//   BASE=http://127.0.0.1:4110 CTL=http://127.0.0.1:15030 USER=devadmin PASS=... node scripts/acceptance.mjs
// Interval rule (enforced by the API): T/H accepts 1 min and 5 min always, 30 s only in commissioning mode, never 10 s. This script switches commissioning mode ON for the run
// (30 s keeps "no update" detection reasonably quick), checks that 10 s and 45 s are rejected, and switches it OFF again at the end. Takes about 7 minutes.
// It creates, freezes and removes things: do NOT run it on the bench while someone is reviewing it (it raises NO UPDATE and GATEWAY OFFLINE alarms on purpose).
//
// SAFETY: by default it only runs against an isolated dev instance (loopback address, port other than 4100). Anything else, including the bench, needs the explicit
// flag  --bench  (and then waits 10 s so it can be aborted). It never acts as a human account: with USER_NAME/PASS (an Admin) it creates its OWN admin user
// "acceptance" with a random password, does everything as that user (so the audit log shows who acted), and deletes the user again at the end, also after a failure or Ctrl-C.
const BASE = process.env.BASE, CTL = process.env.CTL, ADMIN_U = process.env.USER_NAME, ADMIN_P = process.env.PASS, OPU = process.env.OP_USER, OPP = process.env.OP_PASS;
const ACC_USER = "acceptance", ACC_OP = "acceptance-op", ACC_PASS = (await import("node:crypto")).randomBytes(18).toString("base64url");
if (!BASE || !CTL || !ADMIN_U || !ADMIN_P) { console.error("usage: BASE=... CTL=... USER_NAME=<admin> PASS=... node scripts/acceptance.mjs [--bench]"); process.exit(2); }
{ const u = new URL(BASE); const dev = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) && (u.port || "80") !== "4100";
  if (!dev && !process.argv.includes("--bench")) { console.error(`REFUSING to run against ${BASE}: it is not an isolated dev instance. Run it on a dev copy, or add --bench to run it on the bench on purpose.`); process.exit(2); }
  if (!dev) { console.log(`!! running on the BENCH (${BASE}) as user "${ACC_USER}". It raises NO UPDATE and GATEWAY OFFLINE alarms on purpose. Starting in 10 s, Ctrl-C to abort.`); await new Promise((r) => setTimeout(r, 10000)); } }
let cookie = ""; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let fails = 0;
const api = async (m, p, b) => { const r = await fetch(BASE + "/api" + p, { method: m, headers: b ? { "content-type": "application/json", cookie } : { cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return { status: r.status, body: await r.json().catch(() => ({})) }; };
const ctl = (p) => fetch(CTL + p, { method: "POST" }).then((r) => r.json());
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const SERIALS = ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6", "4A01B3F7", "4A01B3F8", "4A01B3F9"];

let cleaned = false;
async function cleanup() {                    // always remove the acceptance users, whatever happened
  if (cleaned) return; cleaned = true; cookie = "";
  try { await api("POST", "/login", { username: ADMIN_U, password: ADMIN_P }); const list = (await api("GET", "/users")).body; for (const u of Array.isArray(list) ? list.filter((x) => [ACC_USER, ACC_OP].includes(x.username)) : []) await api("DELETE", `/users/${u.id}`); } catch { /* best effort */ }
}
process.on("SIGINT", async () => { await cleanup(); process.exit(130); }); process.on("unhandledRejection", async (e) => { console.error(e); await cleanup(); process.exit(1); });
await api("POST", "/login", { username: ADMIN_U, password: ADMIN_P }); { const list = (await api("GET", "/users")).body; for (const old of Array.isArray(list) ? list.filter((x) => [ACC_USER, ACC_OP].includes(x.username)) : []) await api("DELETE", `/users/${old.id}`); }
check("create own acceptance user", (await api("POST", "/users", { username: ACC_USER, password: ACC_PASS, role: "admin" })).status === 200);
check("create own acceptance operator", (await api("POST", "/users", { username: ACC_OP, password: ACC_PASS, role: "operator" })).status === 200);
check("login as acceptance", (await api("POST", "/login", { username: ACC_USER, password: ACC_PASS })).status === 200);
if (process.argv.includes("--selftest")) { await cleanup(); cookie = ""; await api("POST", "/login", { username: ADMIN_U, password: ADMIN_P }); const l = (await api("GET", "/users")).body; check("acceptance users removed", !l.some((x) => [ACC_USER, ACC_OP].includes(x.username))); console.log(fails ? "SELFTEST FAILED" : "SELFTEST OK (create user, login, delete user)"); process.exit(fails ? 1 : 0); }
check("commissioning mode on", (await api("PUT", "/gateway/settings", { commissioning: true })).status === 200);
check("add 8 T/H serials", (await api("POST", "/sensors", { type: "th", serials: SERIALS })).status === 200);
check("duplicate rejected", (await api("POST", "/sensors", { type: "th", serials: [SERIALS[0]] })).status === 400);
check("10 s interval rejected (even in commissioning mode)", (await api("PATCH", `/sensors/${SERIALS[0]}`, { interval: 10 })).status === 400);
check("45 s interval rejected", (await api("PATCH", `/sensors/${SERIALS[0]}`, { interval: 45 })).status === 400);
for (const s of SERIALS) await api("PATCH", `/sensors/${s}`, { interval: 30 });
let r = await api("POST", "/gateway/sync", { types: ["th"] });
check("Send to Gateway: all confirmed", r.status === 200 && r.body[0].items.length === 8 && r.body[0].items.every((i) => i.status === "confirmed"), JSON.stringify(r.body[0]?.items?.map((i) => i.status)));
await api("PATCH", `/sensors/${SERIALS[1]}`, { interval: 60 });
r = await api("POST", "/gateway/sync/plan", { type: "th" }); check("interval change plans exactly one write", r.body.writes.length === 1 && r.body.writes[0].reason === "interval");
r = await api("POST", "/gateway/sync", { types: ["th"] }); check("interval change confirmed", r.body[0].ok);
await api("POST", "/zones", { name: "Greenhouse 1", type: "climate" }); await api("POST", "/zones", { name: "Greenhouse 2", type: "climate" });
const z = (await api("GET", "/structure")).body.zones; for (const [i, s] of SERIALS.entries()) await api("POST", "/zones/assign", { serial: s, zoneId: z[i < 4 ? 0 : 1].id });
console.log("waiting 45 s for readings..."); await sleep(45000);
let d = (await api("GET", `/sensors/${SERIALS[0]}`)).body; const raw = d.sensor.raw.temperature;
check("live values present (raw, voltage, rssi)", typeof raw === "number" && d.sensor.voltage > 3 && d.sensor.rssi < -50, `raw=${raw} V=${d.sensor.voltage} rssi=${d.sensor.rssi}`);
r = await api("POST", `/sensors/${SERIALS[0]}/calibrate`, { metric: "temperature", method: "offset", raw, reference: raw - 0.5 }); check("calibrate with reference", r.status === 200 && r.body.cal.offset === -0.5);
r = await api("POST", `/sensors/${SERIALS[0]}/calibrate`, { metric: "temperature", method: "offset", raw, reference: raw + 9 }); check("out-of-limit calibration refused", r.status === 409);
await sleep(15000);
let v = (await api("GET", "/scada")).body; const s0 = v.zones[0].sensors.find((s) => s.label === SERIALS[0]);
check("SCADA built from structure: 2 zones with sensors", v.zones.length === 2 && v.zones.every((x) => x.sensors.length === 4));
check("SCADA shows calibrated value", s0.temperature !== undefined && Math.abs(s0.temperature - ((await api("GET", `/sensors/${SERIALS[0]}`)).body.sensor.raw.temperature - 0.5)) < 1, `cal=${s0.temperature}`);
{ const adm = cookie; await api("POST", "/login", { username: ACC_OP, password: ACC_PASS }); const ov = (await api("GET", "/scada")).body.zones[0].sensors[0]; check("operator view hides serial/raw/slot/calibration/settings", ["serial", "raw", "slot", "calibratedBy", "calibratedAt", "intervalSec", "lowVoltage", "syncState"].every((k) => ov[k] === undefined) && !/4A01B3F/.test(JSON.stringify((await api("GET", "/scada")).body)) && !/4A01B3F/.test(JSON.stringify((await api("GET", "/alarms/history")).body))); check("operator cannot reach setup", (await api("GET", "/sensors")).status === 403 && (await api("POST", "/gateway/sync", {})).status === 403); cookie = adm; }
console.log("freezing", SERIALS[2], "..."); await ctl(`/freeze?serial=${SERIALS[2]}`); await sleep(120000);
v = (await api("GET", "/scada")).body; check("frozen sensor -> NO UPDATE within 3 intervals", v.zones[0].sensors.find((s) => s.label === SERIALS[2]).status === "no_update" && v.alarms.some((a) => a.kind === "no_update"));
console.log("stopping gateway ..."); await ctl("/stop"); await sleep(50000);
const hOff = (await api("GET", "/alarms/history")).body; const frozen = hOff.find((e) => e.kind === "no_update" && e.cleared_at === null); check("alarm freeze: the NO UPDATE alarm stays open while the gateway is offline, shown as unknown, with the sensor's last data time", !!frozen && frozen.unknown === true && typeof frozen.last_data_at === "number");
v = (await api("GET", "/scada")).body; check("gateway offline shown; sensors unknown; core alive", !v.gateway.online && v.alarms[0].kind === "gateway_offline" && v.zones[0].sensors.every((s) => s.status === "unknown"));
await ctl("/start"); await sleep(40000); v = (await api("GET", "/scada")).body; check("gateway back online", v.gateway.online);
const hOn = (await api("GET", "/alarms/history")).body; check("gateway_offline alarm cleared as recovered; the frozen sensor alarm is still the same open episode", hOn.some((e) => e.kind === "gateway_offline" && e.cleared_at && e.clear_reason === "recovered") && hOn.filter((e) => e.kind === "no_update" && e.cleared_at === null).length === 1);
check("commissioning mode off again", (await api("PUT", "/gateway/settings", { commissioning: false })).status === 200);
const after = (await api("GET", "/sensors")).body.sensors; check("stored 30 s values are flagged, still displayed", after.filter((s) => s.intervalSec === 30).every((s) => s.intervalOk === false) && after.some((s) => s.intervalSec === 30));
check("30 s now rejected", (await api("PATCH", `/sensors/${SERIALS[0]}`, { interval: 30 })).status === 400);
await cleanup(); { cookie = ""; await api("POST", "/login", { username: ADMIN_U, password: ADMIN_P }); const l = (await api("GET", "/users")).body; check("acceptance users removed", !l.some((x) => [ACC_USER, ACC_OP].includes(x.username))); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
