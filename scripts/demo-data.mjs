// Seed or reset the bench DEMO data through the normal API (so it is audited and goes through the same validation as the UI).
//   BASE=http://10.0.0.3:4100 CTL=http://127.0.0.1:5030 USER_NAME=admin PASS=... node scripts/demo-data.mjs seed|reset
// seed : idempotent. 8 simulated T/H sensors (serials 4A01B3F2..F9) with labels, two zones (Greenhouse 1 / 2), one sensor at 5 min and the rest at 1 min,
//        Send to Gateway, and one calibrated sensor once it has a reading. Existing items are left as they are.
// reset: removes the demo sensors, zones and calibrations from CORE, sends that to the gateway (groups cleared) and unfreezes the simulator.
//        Calibration rows stay as history (the API never deletes them). It never touches sensors with other serials, users, history or pump commands.
const BASE = process.env.BASE, CTL = process.env.CTL, U = process.env.USER_NAME, P = process.env.PASS, mode = process.argv[2];
if (!BASE || !U || !P || !["seed", "reset"].includes(mode)) { console.error("usage: BASE=... USER_NAME=... PASS=... [CTL=...] node scripts/demo-data.mjs seed|reset"); process.exit(2); }
let cookie = "";
const api = async (m, p, b) => { const r = await fetch(BASE + "/api" + p, { method: m, headers: b ? { "content-type": "application/json", cookie } : { cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; const body = await r.json().catch(() => ({})); return { status: r.status, body }; };
const ok = (r, what) => { if (r.status >= 400) throw new Error(`${what}: ${r.body.error ?? r.status}`); return r.body; };
const SERIALS = Array.from({ length: 8 }, (_, i) => "4A01B3F" + (2 + i)), ZONES = [["Greenhouse 1", "climate"], ["Greenhouse 2", "climate"]];
ok(await api("POST", "/login", { username: U, password: P }), "login");

if (mode === "seed") {
  const have = new Set(ok(await api("GET", "/sensors"), "list").sensors.map((s) => s.serial));
  const add = SERIALS.filter((s) => !have.has(s)); if (add.length) ok(await api("POST", "/sensors", { type: "th", serials: add, labels: Object.fromEntries(add.map((s, i) => [s, `${i < 4 ? "GH1" : "GH2"} row ${(i % 4) + 1}`])) }), "add sensors");
  for (const [i, s] of SERIALS.entries()) ok(await api("PATCH", `/sensors/${s}`, { interval: i === 7 ? 300 : 60 }), "interval");
  let zs = ok(await api("GET", "/structure"), "structure").zones;
  for (const [n, t] of ZONES) if (!zs.some((z) => z.name === n)) ok(await api("POST", "/zones", { name: n, type: t }), "zone");
  zs = ok(await api("GET", "/structure"), "structure").zones;
  const st = ok(await api("GET", "/structure"), "structure").sensors;
  for (const [i, s] of SERIALS.entries()) if (st.find((x) => x.serial === s)?.zoneId == null) ok(await api("POST", "/zones/assign", { serial: s, zoneId: zs.find((z) => z.name === ZONES[i < 4 ? 0 : 1][0]).id }), "assign");
  if (CTL) for (const s of SERIALS) await fetch(`${CTL}/unfreeze?serial=${s}`, { method: "POST" }).catch(() => {});
  const r = await api("POST", "/gateway/sync", { types: ["th"], confirm: true }); const items = r.body[0]?.items ?? [];
  console.log(r.status === 200 ? `sent: ${items.filter((i) => i.status === "confirmed").length} confirmed, ${items.filter((i) => i.status === "failed").length} failed` : `send failed: ${r.body.error}`);
  // One demo calibration, only when the first sensor has a raw reading and no active calibration yet (needs a few seconds of polling after the first seed).
  const d = ok(await api("GET", `/sensors/${SERIALS[0]}`), "detail"); const raw = d.sensor?.raw?.temperature;
  if (!d.active.temperature && typeof raw === "number") { ok(await api("POST", `/sensors/${SERIALS[0]}/calibrate`, { metric: "temperature", method: "offset", raw, reference: Math.round((raw - 0.4) * 10) / 10, notes: "demo data" }), "calibrate"); console.log("demo calibration applied"); }
  else if (!d.active.temperature) console.log("no reading yet: run seed again in a minute to add the demo calibration");
} else {
  for (const s of SERIALS) { const r = await api("DELETE", `/sensors/${s}`); if (r.status >= 400 && r.status !== 404) throw new Error(`remove ${s}: ${r.body.error ?? r.status}`); }
  for (const z of ok(await api("GET", "/structure"), "structure").zones) if (ZONES.some(([n]) => n === z.name)) ok(await api("DELETE", `/zones/${z.id}`), "remove zone");
  const r = await api("POST", "/gateway/sync", { types: ["th"], confirm: true }); console.log(r.status === 200 ? "gateway groups cleared" : `send failed: ${r.body.error}`);
  if (CTL) for (const s of SERIALS) await fetch(`${CTL}/unfreeze?serial=${s}`, { method: "POST" }).catch(() => {});
}
console.log(mode + " done");
