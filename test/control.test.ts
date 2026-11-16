// 2026-11-16 -- CONTROL section (phase 1): the pump command works from CONTROL for an Operator and an Admin, the SCADA pump card is gone, the SCADA status line
// (deviceState, same state as CONTROL) shows ON / OFF / UNKNOWN and follows a command, and an Operator still gets 403 on every Settings route.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
import { config } from "../src/config.js"; import { CONTROL_DEVICES } from "../src/control.js";
import { deviceState, statusLabel, controlLoadState, GROUPS, type ControlDevice } from "../web/src/control.js"; import type { State } from "../web/src/api.js";

const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const WATER = `farmpilot/${config.farm}/water`;
async function rig() {
  const db = openDb(":memory:"); const ingest = new Ingest(db); let commands!: Commands;
  const mqtt = { publish(topic: string, payload: string) { const c = JSON.parse(payload); if (!topic.includes("/cmd/")) return;       // the simulated pump: ack the command and report the new status
    setTimeout(() => { commands.onAck(Buffer.from(JSON.stringify({ cmd_id: c.cmd_id, ok: true, state: c.action }))); ingest.handle(WATER, Buffer.from(JSON.stringify({ sensors: [{ key: "WPump1", readings: { status: c.action === "on" ? 1 : 0 } }] }))); }, 5); } };
  commands = new Commands(db, mqtt as any, () => {});
  ingest.handle(WATER, Buffer.from(JSON.stringify({ sensors: [{ key: "WPump1", readings: { status: 0 } }] })));
  const { app } = await buildApp(db, ingest, commands, null, null); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => void app.close());
  const port = (app.server.address() as any).port;
  const mk = (name: string, role: string) => { const id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES(?,?,?,?)").run(name, hashPassword("x".repeat(10)), role, 1).lastInsertRowid); return { cookie: "core_session=" + createSession(db, id) }; };
  const admin = mk("admin", "admin"), op = mk("op1", "operator");
  const call = async (who: { cookie: string }, method: string, url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie: who.cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  return { db, admin, op, call };
}
const dev = (await import("../src/control.js")).controlView().devices as unknown as ControlDevice[];
const st = (topics: State["topics"], commands: State["commands"] = []): State => ({ farm: config.farm, now: 0, topics, commands, commandTimeoutSec: 10 });
const top = (status: number, ts: number) => [{ topic: WATER, ts, sensors: [{ key: "WPump1", readings: { status } }] }];

test("control_devices: the pump is the first device (kind pump, on_off); /api/control serves it to Operator and Admin without the driver", async () => {
  assert.equal(CONTROL_DEVICES[0].id, "pump1"); assert.equal(CONTROL_DEVICES[0].kind, "pump"); assert.deepEqual(CONTROL_DEVICES[0].capabilities, ["on_off"]);
  const x = await rig();
  for (const who of [x.op, x.admin]) { const r = await x.call(who, "GET", "/api/control"); assert.equal(r.status, 200); assert.equal(r.json.devices[0].id, "pump1"); assert.equal(r.json.devices[0].feedback.topic, WATER); assert.ok(!("driver" in r.json.devices[0])); }
});

test("Operator and Admin both command the pump (CONTROL uses POST /api/commands), each audited with the user; the status follows the command", async () => {
  const x = await rig(); const pump = dev[0];
  const snap = async () => (await x.call(x.op, "GET", "/api/state")).json as State;
  assert.equal(deviceState(pump, await snap(), Date.now()), "off");
  const a = await x.call(x.op, "POST", "/api/commands", { pump: "pump1", action: "on" }); assert.equal(a.status, 200); assert.equal(a.json.cmd.username, "op1"); assert.equal(a.json.cmd.status, "sent");
  await new Promise((r) => setTimeout(r, 60)); let s = await snap(); assert.equal(s.commands[0].status, "confirmed"); assert.equal(deviceState(pump, s, Date.now()), "on");      // status line: PUMP ON
  await new Promise((r) => setTimeout(r, config.dedupeWindowMs + 50));
  const b = await x.call(x.admin, "POST", "/api/commands", { pump: "pump1", action: "off" }); assert.equal(b.status, 200); assert.equal(b.json.cmd.username, "admin");
  await new Promise((r) => setTimeout(r, 60)); s = await snap(); assert.equal(deviceState(pump, s, Date.now()), "off");
  const rows = x.db.prepare("SELECT username,role FROM audit_log WHERE action='pump.command' ORDER BY id").all() as any[]; assert.deepEqual(rows, [{ username: "op1", role: "operator" }, { username: "admin", role: "admin" }]);
  assert.equal((await x.call(x.op, "POST", "/api/commands", { pump: "nope", action: "on" })).status, 400);
});

test("status line states: ON, OFF, UNKNOWN (stale, missing, no feedback); label is PUMP while it is the only pump", () => {
  const pump = dev[0], now = 1_000_000;
  assert.equal(deviceState(pump, st(top(1, now)), now), "on"); assert.equal(deviceState(pump, st(top(0, now)), now), "off");
  assert.equal(deviceState(pump, st(top(1, now - 31_000)), now), "unknown"); assert.equal(deviceState(pump, st([]), now), "unknown"); assert.equal(deviceState(pump, st(top(7, now)), now), "unknown");
  assert.equal(deviceState({ ...pump, feedback: null }, st(top(1, now)), now), "unknown");
  assert.equal(statusLabel(pump, [pump]), "PUMP"); assert.equal(statusLabel(pump, [pump, { ...pump, id: "pump2", name: "Pump 2" }]), "PUMP 1");
  assert.deepEqual(GROUPS.map((g) => g.title), ["WATER PUMPS", "FANS", "VALVES AND ACTUATORS", "OTHER"]);
});

test("the SCADA pump card is gone and CONTROL, the status line and the nav exist (source check)", () => {
  const scada = readFileSync("web/src/ScadaView.tsx", "utf8"); assert.ok(!/PumpCard|Start pump|\/commands/.test(scada), "ScadaView must not contain the pump card or send commands"); assert.match(scada, /ControlStatusLine/);
  assert.match(readFileSync("web/src/ControlCard.tsx", "utf8"), /The PLC keeps its own logic; this panel only sends commands\./);
  assert.match(readFileSync("web/src/ControlPage.tsx", "utf8"), /Fans, valves and other actuators will appear here when they are configured/);
  const app = readFileSync("web/src/App.tsx", "utf8"), sb = readFileSync("web/src/Sidebar.tsx", "utf8"); assert.match(app, /go\("\/control"\)[\s\S]*ALARMS/); assert.ok(sb.indexOf('go("/scada")') < sb.indexOf('go("/control")') && sb.indexOf('go("/control")') < sb.indexOf('go("/alarms")'));
  assert.ok(app.indexOf('go("/scada")') < app.indexOf('go("/control")') && app.indexOf('go("/control")') < app.indexOf('go("/alarms")') && app.indexOf('go("/alarms")') < app.indexOf('go("/settings")'), "bottom nav order SCADA, CONTROL, ALARMS, SETTINGS");
  assert.ok(!/ControlStatusLine[\s\S]*api\(/.test(readFileSync("web/src/ControlStatusLine.tsx", "utf8")), "the status line makes no request of its own");
});

test("Operator access to Settings routes is still 403; CONTROL routes are allowed", async () => {
  const x = await rig();
  for (const [m, u, b] of [["GET", "/api/users"], ["POST", "/api/users", { username: "zz", password: "12345678", role: "admin" }], ["PUT", "/api/settings", { commandTimeoutSec: 20 }], ["DELETE", "/api/users/1"], ["POST", "/api/users/1", { active: false }]] as const) assert.equal((await x.call(x.op, m, u, b)).status, 403, `${m} ${u}`);
  assert.equal((await x.call(x.op, "GET", "/api/control")).status, 200);
});

test("CONTROL API: anonymous gets 401, the device list has the pump FIRST with on_off, an unknown /api route is a JSON 404 (what an old build answers)", async () => {
  const x = await rig();
  const r = await x.call({ cookie: "" }, "GET", "/api/control"); assert.equal(r.status, 401);
  const ok = await x.call(x.op, "GET", "/api/control"); assert.equal(ok.json.devices.length, CONTROL_DEVICES.length); assert.equal(ok.json.devices[0].id, "pump1"); assert.deepEqual(ok.json.devices[0].capabilities, ["on_off"]);
  const nf = await x.call(x.op, "GET", "/api/control-does-not-exist"); assert.equal(nf.status, 404);
});

test("CONTROL page states: loading, error (with RETRY) and loaded; a failed request never stays on loading", () => {
  const d = dev; assert.equal(controlLoadState(null, null, false), "loading"); assert.equal(controlLoadState(d, null, false), "loading"); assert.equal(controlLoadState(null, "x", true), "error"); assert.equal(controlLoadState(d, "x", true), "error");
  assert.equal(controlLoadState(d, null, true), "loaded");
  const page = readFileSync("web/src/ControlPage.tsx", "utf8"); assert.match(page, /data-testid="control-error"/); assert.match(page, />RETRY</); assert.match(page, /data-testid="control-loading"/);
  const app = readFileSync("web/src/App.tsx", "utf8"); assert.ok(!/\/control"\)\.then\([^)]*\)\.catch\(\(\) => \{\}\)/.test(app), "the /control request must not swallow its error"); assert.match(app, /AbortController/);
  assert.match(readFileSync("web/src/ControlStatusLine.tsx", "utf8"), /RETRY/);
});

test("SCADA draws no zone card for a non-climate zone without sensors (VFD Section # 1); climate zones always show; nothing is deleted", () => {
  const sv = readFileSync("web/src/ScadaView.tsx", "utf8"); assert.match(sv, /z\.type === "climate" \|\| z\.total > 0/); assert.ok(!/scada\.zones\.map/.test(sv));
});
