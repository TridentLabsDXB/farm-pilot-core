import "./isolate.js";
// Data sources > PLC and V-BOX (specs core-plc-data-source-page.md, core-vbox-data-source-page.md, core-licence-tiers.md "Feature gating"). No hardware, no external network:
// the PLC is the bench simulator (a real Modbus TCP server on a loopback port), the licence is a fake summary of each tier.
import test, { after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync, readdirSync } from "node:fs";
import { openDb, type Db } from "../src/db.js"; import { Ingest } from "../src/ingest.js";
import { PLC_VBOX_LOCKED_MESSAGE, TIER_NAMES, TIERS, canAddDataSource, plcVboxRefusal, tierAllowsPlcVbox, type Tier } from "../src/deployments/tiers.js";
import { plcVboxServiceState } from "../src/licence/dataSources.js"; import { LicenceService } from "../src/licence/service.js"; import { usage } from "../src/licence/usage.js"; import type { LicenceSummary } from "../src/licence/summary.js";
import { toOffset, zoneRequest, checkPoints, type PointDef } from "../src/plc/address.js"; import { decodePoint } from "../src/plc/decode.js";
import { PlcService, nextLink, reasonOf, backoff, OFFLINE_CYCLES, PLC_SERIES_TOPIC } from "../src/plc/service.js"; import { PlcSim } from "../src/tools/plc-sim/sim.js";
import { VboxSource, parseVbox } from "../src/vbox/service.js"; import { VBOX_SERIES_TOPIC, VBOX_DEFAULT_TAGS } from "../src/vbox/defaults.js";
import { MqttSourceService } from "../src/mqtt/service.js"; import { SERIES_TOPIC } from "../src/mqtt/defaults.js";
import { crc16, ModbusException, ModbusTimeout, mbapWrap, parseResponse, readPdu, rtuWrap } from "../src/drivers/modbus/frames.js"; import { matchRtuResponse } from "../src/drivers/modbus/transport.js";
import { ModbusMaster } from "../src/drivers/modbus/master.js";
import { rig } from "./rig.js";

const closers: (() => Promise<void> | void)[] = []; after(async () => { for (const c of closers.reverse()) await c(); });
const A = { username: "admin", role: "admin" };
const NOW = Date.parse("2026-11-18T12:00:00Z");
function summary(db: Db, type: Tier | "EXPIRED_PRO", extra: Partial<LicenceSummary> = {}, used?: number): LicenceSummary {
  const t = (type === "EXPIRED_PRO" ? "PRO" : type) as Tier, lim = type === "EXPIRED_PRO" ? TIERS.FREE : TIERS[t], u = usage(db);
  return { type: t, licensed_to: type === "FREE" ? null : "Test", valid_until: null, state: type === "FREE" ? "FREE" : type === "EXPIRED_PRO" ? "EXPIRED" : "LICENSED", limits: { gateways: lim.gateways, sensors: lim.sensors },
    usage: { ...u, gateways: used ?? u.gateways }, over_limit: false, reports_days: null, retention_days: null, ...extra };
}
/** A licence of the given tier (the real service with summary() replaced, so checkDataSourceAdd runs the real code). */
function licenceOf(db: Db, type: Tier | "EXPIRED_PRO", used?: () => number | undefined, extra: Partial<LicenceSummary> = {}) { const real = new LicenceService(db); return Object.assign(Object.create(real), { summary: () => summary(db, type, extra, used?.()) }) as LicenceService; }

test("one rule by tier rank: FREE locked, PRO / FULL / ENGINEERING open; same helper gives the 403 answer", () => {
  assert.deepEqual(TIER_NAMES, ["FREE", "PRO", "FULL", "ENGINEERING"]);
  assert.equal(tierAllowsPlcVbox("FREE"), false); for (const t of ["PRO", "FULL", "ENGINEERING"]) assert.equal(tierAllowsPlcVbox(t), true);
  assert.equal(tierAllowsPlcVbox("STANDARD"), false); assert.equal(tierAllowsPlcVbox(undefined), false);
  assert.equal(PLC_VBOX_LOCKED_MESSAGE, "PLC and V-BOX need a PRO licence or higher. Upload a licence on the About page.");
  assert.deepEqual(plcVboxRefusal("FREE"), { status: 403, error: PLC_VBOX_LOCKED_MESSAGE }); assert.equal(plcVboxRefusal("FULL"), null);
});
test("each PLC and each V-BOX source counts 1 data source and adding stops at the tier limit (FREE 1, PRO 5, FULL 25, ENGINEERING none)", () => {
  for (const [t, lim] of [["FREE", 1], ["PRO", 5], ["FULL", 25]] as const) { assert.equal(canAddDataSource(t, lim - 1), true, `${t} below the limit`); assert.equal(canAddDataSource(t, lim), false, `${t} at the limit`); }
  assert.equal(canAddDataSource("ENGINEERING", 100000), true);
  const db = openDb(":memory:"), i = new Ingest(db), lic = licenceOf(db, "PRO"); new PlcService(db, i, lic); new VboxSource(db, i, lic);
  assert.equal(usage(db).gateways, 0); db.prepare("UPDATE plc_config SET enabled=1").run(); assert.equal(usage(db).gateways, 1); db.prepare("UPDATE vbox_config SET enabled=1").run(); assert.equal(usage(db).gateways, 2, "V-BOX is its own data source, not part of MQTT");
  db.prepare("UPDATE plc_config SET enabled=0").run(); db.prepare("UPDATE vbox_config SET enabled=0").run();
  let used = 4; const l5 = licenceOf(db, "PRO", () => used); l5.checkDataSourceAdd(1); used = 5; assert.throws(() => l5.checkDataSourceAdd(1), (e: any) => e.status === 409 && /data source/.test(e.message));
});
test("downgrade or expiry: running with a warning in the 30-day grace, stopped after it, never deleted (ONE function, owner to confirm)", () => {
  const db = openDb(":memory:"), grace = { downgrade_at: new Date(NOW - 5 * 864e5).toISOString(), delete_on: new Date(NOW + 25 * 864e5).toISOString() };
  assert.equal(plcVboxServiceState(summary(db, "PRO"), NOW).state, "allowed"); assert.equal(plcVboxServiceState(summary(db, "FREE"), NOW).state, "locked");
  const g = plcVboxServiceState(summary(db, "EXPIRED_PRO", { grace }), NOW); assert.equal(g.state, "grace"); assert.equal(g.run, true); assert.match(g.message!, /keep running until 2026-12-13/);
  const s = plcVboxServiceState(summary(db, "EXPIRED_PRO", { grace: { downgrade_at: grace.downgrade_at, delete_on: new Date(NOW - 864e5).toISOString() } }), NOW); assert.equal(s.state, "stopped"); assert.equal(s.run, false);
  assert.equal(plcVboxServiceState(summary(db, "FULL"), NOW).run, true, "a valid licence restores it at once");
});

test("PLC address conversion for each style, the exact request and the split at 120 registers", () => {
  assert.equal(toOffset("holding", "plc", 40001), 0); assert.equal(toOffset("holding", "plc", 40100), 99); assert.equal(toOffset("input", "plc", 30001), 0); assert.equal(toOffset("coils", "plc", 1), 0); assert.equal(toOffset("coils", "plc", 9999), 9998); assert.equal(toOffset("discrete", "plc", 10001), 0);
  assert.equal(toOffset("holding", "protocol", 0), 0); assert.equal(toOffset("holding", "protocol", 40000), 40000); assert.equal(toOffset("coils", "protocol", 65535), 65535);
  assert.throws(() => toOffset("holding", "plc", 30001), /40001 to 49999/); assert.throws(() => toOffset("holding", "plc", 0), /use the protocol style/); assert.throws(() => toOffset("holding", "protocol", 65536), /65535/); assert.throws(() => toOffset("holding", "protocol", -1), /whole number/);
  const r = zoneRequest({ area: "holding", style: "plc", start: 40011, length: 10 });
  assert.deepEqual({ fc: r.fc, offset: r.offset, end: r.end, plcStart: r.plcStart, plcEnd: r.plcEnd, chunks: r.chunks }, { fc: 3, offset: 10, end: 19, plcStart: 40011, plcEnd: 40020, chunks: [{ fc: 3, offset: 10, count: 10 }] });
  assert.deepEqual(zoneRequest({ area: "holding", style: "protocol", start: 0, length: 250 }).chunks.map((c) => [c.offset, c.count]), [[0, 120], [120, 120], [240, 10]]);
  assert.equal(zoneRequest({ area: "input", style: "protocol", start: 5, length: 1 }).fc, 4); assert.equal(zoneRequest({ area: "coils", style: "protocol", start: 0, length: 8 }).fc, 1); assert.equal(zoneRequest({ area: "discrete", style: "protocol", start: 0, length: 8 }).fc, 2);
  assert.deepEqual(zoneRequest({ area: "coils", style: "protocol", start: 0, length: 2000 }).chunks.map((c) => c.count), [1920, 80]);
  assert.throws(() => zoneRequest({ area: "holding", style: "protocol", start: 65530, length: 10 }), /65535/); assert.throws(() => zoneRequest({ area: "holding", style: "protocol", start: 0, length: 0 }), /length/); assert.throws(() => zoneRequest({ area: "holding", style: "plc", start: 49990, length: 20 }), /PLC style range/);
});
test("points: overlap, range and area validation", () => {
  const P = (o: number, n: string, t: PointDef["type"] = "UINT16"): PointDef => ({ offset: o, name: n, type: t, scale: 1, unit: "" });
  assert.equal(checkPoints("holding", 10, [P(0, "a"), P(1, "b"), P(2, "c", "FLOAT32"), P(4, "d", "INT32")]), null);
  assert.match(checkPoints("holding", 10, [P(0, "a", "FLOAT32"), P(1, "b")])!, /overlaps a at offset 1/); assert.match(checkPoints("holding", 4, [P(3, "a", "INT32")])!, /outside the zone length 4/);
  assert.match(checkPoints("holding", 4, [P(0, "a"), P(1, "a")])!, /used twice/); assert.match(checkPoints("holding", 4, [P(0, "Bad Name")])!, /lower case/); assert.match(checkPoints("coils", 4, [P(0, "a", "UINT16")])!, /BOOL points only/);
  assert.equal(checkPoints("coils", 4, [P(0, "a", "BOOL"), P(3, "b", "BOOL")]), null); assert.match(checkPoints("holding", 4, [{ ...P(0, "a"), scale: 0 }])!, /scale/);
});
test("decode: every type, scale and the per-PLC word order", () => {
  const D = (type: PointDef["type"], raw: number[], scale = 1, order: "big" | "little" = "big", area: any = "holding") => decodePoint(area, raw, { offset: 0, name: "x", type, scale, unit: "" }, order);
  assert.equal(D("UINT16", [65535]), 65535); assert.equal(D("INT16", [65535]), -1); assert.equal(D("INT16", [100], 0.1), 10); assert.equal(D("BOOL", [0]), 0); assert.equal(D("BOOL", [7]), 1);
  assert.equal(D("UINT32", [1, 0]), 65536); assert.equal(D("UINT32", [1, 0], 1, "little"), 1); assert.equal(D("INT32", [0xffff, 0xffff]), -1);
  const f = Buffer.alloc(4); f.writeFloatBE(21.5); assert.equal(D("FLOAT32", [f.readUInt16BE(0), f.readUInt16BE(2)]), 21.5); assert.equal(D("FLOAT32", [f.readUInt16BE(2), f.readUInt16BE(0)], 1, "little"), 21.5);
  assert.equal(D("UINT16", []), null); assert.equal(D("BOOL", [1, 0], 1, "big", "coils"), 1);
});

test("Modbus: bit reads (FC01/02), RTU CRC check and timeout / exception reason texts", async () => {
  assert.deepEqual(parseResponse(readPdu(1, 0, 10), Buffer.from([1, 2, 0b00000101, 0b10])), [1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  assert.throws(() => parseResponse(readPdu(2, 0, 10), Buffer.from([2, 1, 0xff])), /wrong-sized/);
  const pdu = readPdu(3, 0, 1), good = rtuWrap(1, Buffer.from([3, 2, 0x12, 0x34])); assert.ok(Buffer.isBuffer(matchRtuResponse(good, 1, pdu)));
  const bad = Buffer.from(good); bad[bad.length - 1] ^= 0xff; const m = matchRtuResponse(bad, 1, pdu); assert.ok(typeof m === "object" && m !== null && !Buffer.isBuffer(m) && /bad CRC/.test(m.fail), "bad CRC is rejected, never accepted");
  assert.ok(Buffer.isBuffer(matchRtuResponse(rtuWrap(1, Buffer.from([1, 1, 0b101])), 1, readPdu(1, 0, 3))), "FC01 reply accepted");
  assert.deepEqual(reasonOf(new ModbusException(3, 2)), { status: "BAD DATA", reason: "exception 02: illegal data address" }); assert.equal(reasonOf(new ModbusTimeout("timeout: no reply within 300 ms (FC03 addr 0x0000 count 1)")).status, "NO ANSWER");
  const m2 = new ModbusMaster({ request: async () => { throw new ModbusTimeout("timeout: no reply within 50 ms"); }, close: async () => {} }, { unit: 1, timeoutMs: 50, retries: 0 });
  await assert.rejects(() => m2.read(3, 0, 1), (e: any) => reasonOf(e).status === "NO ANSWER" && /timeout: no reply/.test(reasonOf(e).reason));
});

async function plcRig(type: Tier | "EXPIRED_PRO" = "PRO") {
  const sim = new PlcSim(); sim.tick(); const port = await sim.listen(0); closers.push(() => sim.close());
  const db = openDb(":memory:"), ing = new Ingest(db), svc = new PlcService(db, ing, licenceOf(db, type)); closers.push(() => svc.stop());
  await svc.saveConfig(A, { protocol: "tcp", host: "127.0.0.1", port, unit: 1, poll_s: 1, timeout_ms: 300 }); db.prepare("UPDATE plc_config SET enabled=1").run(); return { sim, port, db, svc };
}
const series = (db: Db, topic: string) => db.prepare("SELECT s.sensor_key k, s.metric m, l.value v FROM latest l JOIN series s ON s.id=l.series_id WHERE s.topic=? ORDER BY s.sensor_key, s.metric").all(topic) as { k: string; m: string; v: number }[];

test("PLC over Modbus TCP: add a zone, poll, values stored as measurements; READ ZONE NOW shows the request and raw registers and stores nothing", async () => {
  const { sim, db, svc } = await plcRig();
  const v = svc.saveZone(A, null, { name: "Sample zone", area: "holding", style: "plc", start: 40001, length: 4, points: [{ offset: 1, name: "temp", type: "UINT16", scale: 0.1, unit: "°C" }, { offset: 2, name: "flow", type: "FLOAT32", scale: 1, unit: "l/s", maps_to: "Flow" }] });
  const z = v.zones[0]; assert.equal(z.code, "DZ1"); assert.deepEqual(z.request!.chunks, [{ fc: 3, offset: 0, count: 4 }]);
  const now = await svc.readNow(A, z.id); assert.equal(now.ok, true); assert.equal((now as any).raw.length, 4); assert.equal(series(db, PLC_SERIES_TOPIC).length, 0, "READ ZONE NOW stores nothing");
  assert.equal((await svc.pollOnce()).ok, true); const s = series(db, PLC_SERIES_TOPIC); assert.deepEqual(s.map((x) => x.m), ["flow", "temp"]); assert.ok(Math.abs(s.find((x) => x.m === "flow")!.v - 21.5) < 4);
  assert.equal(svc.view().zones[0].status, "OK");
  // coils zone (FC01)
  svc.saveZone(A, null, { name: "Bits", area: "coils", style: "protocol", start: 0, length: 16, points: [{ offset: 3, name: "run", type: "BOOL" }] }); assert.equal((await svc.pollOnce()).ok, true);
  assert.ok(sim.seen.length > 0 && sim.seen.every((fc) => fc >= 1 && fc <= 4), `only read function codes reached the PLC: ${[...new Set(sim.seen)]}`);
});
test("PLC failures: NO ANSWER, BAD DATA with the reason, OFFLINE only after 3 failed cycles in a row, recovery", async () => {
  const { sim, svc } = await plcRig(); svc.saveZone(A, null, { name: "Z", area: "holding", style: "protocol", start: 0, length: 2, points: [] });
  assert.deepEqual([nextLink(0, false), nextLink(2, false), nextLink(2, true)], [{ fails: 1, offline: false }, { fails: 3, offline: true }, { fails: 0, offline: false }]); assert.equal(OFFLINE_CYCLES, 3);
  assert.equal(backoff(0, 5000), 5000); assert.ok(backoff(3, 5000) >= 5000 && backoff(20, 5000) <= 60000);
  await svc.pollOnce(); assert.equal(svc.view().status.link, "online");
  sim.mode = "silent"; await svc.pollOnce(); assert.equal(svc.view().zones[0].status, "NO ANSWER"); assert.match(svc.view().zones[0].reason!, /timeout|no reply/); assert.notEqual(svc.view().status.link, "offline", "one failed cycle is not OFFLINE");
  await svc.pollOnce(); assert.notEqual(svc.view().status.link, "offline", "two are not either"); await svc.pollOnce(); assert.equal(svc.view().status.link, "offline");
  sim.mode = "exception"; await svc.pollOnce(); assert.equal(svc.view().zones[0].status, "BAD DATA"); assert.equal(svc.view().zones[0].reason, "exception 02: illegal data address");
  sim.mode = "ok"; assert.equal((await svc.pollOnce()).ok, true); assert.equal(svc.view().status.link, "online"); assert.equal(svc.view().zones[0].status, "OK");
});
test("PLC is read only: no write function code in the PLC code, none on the wire, writes are refused by the simulator", () => {
  for (const f of readdirSync("src/plc")) { const t = readFileSync("src/plc/" + f, "utf8").replace(/\/\/.*$/gm, ""); assert.ok(!/\bwrite1\b|\bwriteN\b|write1Pdu|writeNPdu|\.writeN?\(|MAX_WRITE/.test(t.replace(/Buffer|\.write(UInt|Int|Float)/g, "")), `src/plc/${f} has no write path`); }
  const sim = new PlcSim(); for (const fc of [5, 6, 15, 16]) assert.deepEqual([...sim.respond(Buffer.from([fc, 0, 0, 0, 1]))!], [fc | 0x80, 1]);
  const src = readFileSync("src/plc/service.ts", "utf8"); assert.match(src, /interface PlcReader \{ readRegs.*readBits.*close/s); assert.ok(!/write/i.test(src.slice(src.indexOf("export interface PlcReader"), src.indexOf("export interface PlcLicence"))));
});
test("PLC protocol OTHER is listed but not available; bad settings are plain 400s", async () => {
  const { svc } = await plcRig(); await svc.saveConfig(A, { protocol: "other" }); assert.equal((await svc.test(A)).ok, false); assert.match((await svc.test(A)).message, /not available yet/);
  await assert.rejects(() => svc.saveConfig(A, { protocol: "profibus" }), /Modbus TCP, Modbus RTU or OTHER/); await assert.rejects(() => svc.saveConfig(A, { port: 70000 }), /port must be/);
  await assert.rejects(async () => svc.saveZone(A, null, { name: "x", area: "holding", style: "plc", start: 5, length: 4 }), /PLC style/);
});

async function api(type: Tier | "EXPIRED_PRO", used?: () => number | undefined, extra: Partial<LicenceSummary> = {}) {
  const db = openDb(":memory:"), lic = licenceOf(db, type, used, extra), r = await rig({ db, lic }); closers.push(() => r.close()); return r;
}
test("API: FREE cannot create or enable PLC / V-BOX (403 with the tier message), data stays readable; PRO, FULL, ENGINEERING can", async () => {
  const f = await api("FREE");
  for (const [m, u, b] of [["POST", "/api/plc/zones", { name: "x", area: "holding", style: "protocol", start: 0, length: 2 }], ["POST", "/api/plc/enabled", { enabled: true }], ["PUT", "/api/plc/config", { host: "1.2.3.4" }], ["POST", "/api/plc/test", {}],
    ["POST", "/api/vbox/enabled", { enabled: true }], ["PUT", "/api/vbox/preset", { topic_filter: "vbox/+/data" }], ["PUT", "/api/vbox/tags", { tags: [] }]] as const) {
    const r = await f.call(f.admin, m, u, b); assert.equal(r.status, 403, `${m} ${u}`); assert.equal(r.json.error, PLC_VBOX_LOCKED_MESSAGE);
  }
  assert.equal((await f.call(f.admin, "GET", "/api/plc")).status, 200); assert.equal((await f.call(f.admin, "GET", "/api/vbox")).status, 200); assert.equal((await f.call(f.admin, "GET", "/api/data-sources/access")).json.state, "locked");
  for (const t of ["PRO", "FULL", "ENGINEERING"] as const) {
    const a = await api(t); assert.equal((await a.call(a.admin, "POST", "/api/plc/zones", { name: "x", area: "holding", style: "protocol", start: 0, length: 2 })).status, 200, t);
    assert.equal((await a.call(a.admin, "POST", "/api/plc/enabled", { enabled: true })).status, 200, t); assert.equal((await a.call(a.admin, "POST", "/api/vbox/enabled", { enabled: true })).status, 200, t);
    assert.equal((await a.call(a.admin, "GET", "/api/data-sources/access")).json.state, "allowed");
  }
});
test("API: enabling a source at the tier limit is refused (409), below it works; Operators get 403 on every new route", async () => {
  let used: number | undefined = 5; const a = await api("PRO", () => used);
  const r = await a.call(a.admin, "POST", "/api/plc/enabled", { enabled: true }); assert.equal(r.status, 409); assert.match(r.json.error, /allows 5 data sources/);
  assert.equal((await a.call(a.admin, "POST", "/api/vbox/enabled", { enabled: true })).status, 409); used = 4; assert.equal((await a.call(a.admin, "POST", "/api/plc/enabled", { enabled: true })).status, 200);
  for (const [m, u] of [["GET", "/api/plc"], ["PUT", "/api/plc/config"], ["POST", "/api/plc/enabled"], ["POST", "/api/plc/zones"], ["POST", "/api/plc/zones/1/read"], ["GET", "/api/vbox"], ["PUT", "/api/vbox/tags"], ["POST", "/api/vbox/units/x/add"], ["GET", "/api/data-sources/access"]]) {
    const o = await a.call(a.op, m, u, m === "GET" ? undefined : {}); assert.equal(o.status, 403, `${m} ${u} as Operator`); assert.ok(!/address|raw|holding/i.test(o.txt), "no addresses in an Operator refusal");
  }
});

const O = { idFrom: "topic" as const, idLevel: 2, idPath: "id", tsPath: "ts", tags: VBOX_DEFAULT_TAGS };
test("V-BOX mapping: valid payload, missing tag, wrong type, invalid JSON, unknown tags, id from a payload field", () => {
  let m = parseVbox("vbox/VB1/data", JSON.stringify({ gh1_temp: 24.5, gh1_hum: 60, tank_level: 80 }), O); assert.equal(m.status, "ok"); assert.equal(m.unit, "VB1"); assert.deepEqual(m.values.map((v) => v.value), [24.5, 60, 80]);
  m = parseVbox("vbox/VB1/data", JSON.stringify({ gh1_temp: 24.5 }), O); assert.equal(m.status, "ok"); assert.deepEqual(m.missing, ["gh1_hum", "tank_level"]);
  m = parseVbox("vbox/VB1/data", JSON.stringify({ gh1_temp: "hot", gh1_hum: 1 }), O); assert.equal(m.status, "error"); assert.match(m.errors[0], /must be a number/); assert.equal(m.values.length, 1);
  m = parseVbox("vbox/VB1/data", "{not json", O); assert.equal(m.status, "error"); assert.deepEqual(m.errors, ["invalid JSON"]); assert.equal(parseVbox("vbox/VB1/data", "[1]", O).status, "error");
  m = parseVbox("vbox/VB1/data", JSON.stringify({ gh1_temp: 1, extra: 5 }), O); assert.equal(m.status, "unmapped"); assert.deepEqual(m.unmapped, ["extra"]);
  assert.equal(parseVbox("vbox", "{}", O).unit, null); assert.equal(parseVbox("x/y", JSON.stringify({ id: "U9", gh1_temp: 2 }), { ...O, idFrom: "payload" }).unit, "U9"); assert.equal(parseVbox("x/y", "{}", { ...O, idFrom: "payload" }).status, "error");
});
test("V-BOX source: preset subscription, units found (add / ignore / remove), only ADDED units are stored, FREE ingests nothing, MQTT Payload keeps the other devices", async () => {
  const db = openDb(":memory:"), ing = new Ingest(db); let type: Tier = "PRO"; const real = new LicenceService(db), lic = Object.assign(Object.create(real), { summary: () => summary(db, type) }) as LicenceService;
  const vb = new VboxSource(db, ing, lic), mq = new MqttSourceService(db, ing); mq.attachVbox(vb);
  assert.equal(vb.subscription(), null, "off until enabled"); vb.setEnabled(A, true); assert.equal(vb.subscription(), "vbox/+/data"); assert.equal(vb.view().preset.status, "APPLIED");
  const on = (t: string, p: unknown) => (mq as any).onMessage(t, Buffer.from(typeof p === "string" ? p : JSON.stringify(p)));
  on("vbox/VB1/data", { gh1_temp: 24, gh1_hum: 55 }); assert.equal(vb.view().units[0].state, "new"); assert.equal(series(db, VBOX_SERIES_TOPIC).length, 0, "not added yet: nothing stored");
  vb.setUnit(A, "VB1", "add"); on("vbox/VB1/data", { gh1_temp: 25, gh1_hum: 56, other: 1 }); assert.deepEqual(series(db, VBOX_SERIES_TOPIC).map((x) => [x.k, x.m, x.v]), [["VB1", "gh1_hum", 56], ["VB1", "gh1_temp", 25]]);
  assert.equal(vb.view().units[0].tag_count, 2); assert.equal(vb.view().tags[0].readings[0].unit, "VB1");
  on("vbox/VB2/data", "not json"); on("fp/dev1/data", { id: "dev1", t: 20 }); const v = mq.view();
  assert.equal(v.messages.find((x: any) => x.topic === "fp/dev1/data").vbox, undefined, "OTHER DEVICES = messages that do not match the preset"); assert.equal(v.messages.filter((x: any) => x.vbox).length, 3); assert.equal(v.messages.find((x: any) => x.topic === "vbox/VB2/data").status, "error");
  assert.equal(v.devices.some((d: any) => d.device_id === "dev1"), true); assert.equal(v.devices.some((d: any) => d.device_id === "VB1"), false, "V-BOX units are not MQTT Payload devices");
  vb.setUnit(A, "VB1", "ignore"); on("vbox/VB1/data", { gh1_temp: 99 }); assert.equal(series(db, VBOX_SERIES_TOPIC).find((x) => x.m === "gh1_temp")!.v, 25, "ignored: not stored");
  vb.setUnit(A, "VB1", "remove"); assert.equal(vb.view().units.some((u: any) => u.unit_id === "VB1"), false); assert.equal(series(db, VBOX_SERIES_TOPIC).length, 2, "removing a unit never deletes stored data");
});
test("V-BOX on FREE: nothing is ingested and the message says why", () => {
  const db = openDb(":memory:"), ing = new Ingest(db); let type: Tier = "PRO"; const real = new LicenceService(db), lic = Object.assign(Object.create(real), { summary: () => summary(db, type) }) as LicenceService, vb = new VboxSource(db, ing, lic);
  vb.setEnabled(A, true); vb.handle("vbox/VB1/data", Buffer.from("{}")); vb.setUnit(A, "VB1", "add"); type = "FREE";
  const r = vb.handle("vbox/VB1/data", Buffer.from(JSON.stringify({ gh1_temp: 3 }))); assert.equal(r.stored, false); assert.ok(r.notes.some((n) => /licence/.test(n))); assert.equal(series(db, VBOX_SERIES_TOPIC).length, 0); assert.equal(vb.subscription(), null);
  assert.throws(() => vb.setEnabled(A, false), (e: any) => e.status === 403);
});
