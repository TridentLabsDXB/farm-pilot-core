import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// Menu structure of 2026-11-17 (source checks, same style as control.test.ts / about.test.ts): Admin sees ALARMS, MONITORING, CONTROL and the groups
// SETTINGS, DATA SOURCES, SYSTEM, ABOUT pinned at the bottom; Operators get no group headings (one plain MQTT PAYLOAD item, read only); every old settings route still opens its page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8");
const groups = (() => { const body = sb.slice(sb.indexOf("export const GROUPS"), sb.indexOf("export const TABS")); return [...body.matchAll(/title: "([^"]+)", tabs: \[((?:\["[^"]+", "[^"]+"\],? ?)+)\]/g)].map((m) => ({ title: m[1], tabs: [...m[2].matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((t) => t[1]) })); })();

test("Admin groups and their order: SETTINGS, DATA SOURCES, SYSTEM", () => {
  assert.deepEqual(groups, [
    { title: "Settings", tabs: ["farm-profile", "farm-structure"] },
    { title: "Data sources", tabs: ["rs485-ports", "sensors-gateway", "plc", "vbox", "mqtt-payload", "sensors"] },
    { title: "System", tabs: ["users", "backup"] },
  ]);
  assert.match(sb, /export const TABS: \[string, string\]\[\] = GROUPS\.flatMap/);
});

test("Sidebar order: ALARMS, MONITORING, CONTROL, the three groups, then ABOUT pinned at the bottom above the version caption; REPORTS not in the menu yet", () => {
  const i = (x: string) => sb.indexOf(x);
  assert.ok(i('go("/alarms")') < i('go("/monitoring")') && i('go("/monitoring")') < i('go("/control")') && i('go("/control")') < i("GROUPS.filter") && i("GROUPS.filter") < i('fp-sb-bottom') && i('fp-sb-bottom') < i(">ABOUT</button>") && i(">ABOUT</button>") < i("fp-sb-ver"));
  assert.ok(!/REPORTS/.test(sb) && !/REPORTS/.test(app));
});

test("Operator: group headings and group items render for Admin only (sidebar and MORE sheet); a group with no items is not rendered", () => {
  assert.match(sb, /\{admin && GROUPS\.filter\(\(g\) => g\.tabs\.length > 0\)\.map\(/);
  assert.ok(sb.indexOf("{admin && GROUPS") < sb.indexOf('className="fp-cap fp-sb-group">{g.title}'), "the heading sits inside the admin-only block");
  assert.match(ab, /\{admin && GROUPS\.filter\(\(g\) => g\.tabs\.length > 0\)\.map\(/); assert.ok(ab.indexOf("{admin && GROUPS") < ab.indexOf("{g.title}</span>"));
  // ABOUT is outside the admin block in both places, so an Operator still has it
  assert.ok(sb.indexOf(">ABOUT</button>") > sb.indexOf("</div>)}")); assert.match(ab, /row\("about", "ABOUT", "\/about"\)/);
  assert.match(app, /page === "settings" && \(admin \|\| rest\[0\] === "mqtt-payload"\) \? "settings"/);   // Operators: only the read-only MQTT Payload page (owner decision 2026-11-18) assert.match(app, /me\.role !== "admin" && page === "settings" && rest\[0\] !== "mqtt-payload"\) go\("\/monitoring"\)/);
});

test("Phone: bottom nav ALARMS, MONITORING, CONTROL, MORE for both roles; the MORE sheet shows the same groups (with badges) and ABOUT; the old phone Settings list leads to it", () => {
  assert.ok(!/>SETTINGS<\/button>/.test(app)); assert.match(app, /onClick=\{\(\) => go\("\/more"\)\}>MORE<\/button>/); assert.match(app, /cur === "more" \|\| cur === "about" \|\| cur === "settings"/);
  assert.match(app, /<MorePage admin=\{admin\} badges=\{badges\}/); assert.match(ab, /GROUPS\.filter/); assert.match(ab, /badges\[k\]/);
  assert.match(st, /phone && !t\) return <Redirect to="\/more" \/>/);
});

test("Every old settings route still opens its page and is highlighted under its new group", () => {
  const all = groups.flatMap((g) => g.tabs).sort();
  assert.deepEqual(all, ["backup", "farm-profile", "farm-structure", "mqtt-payload", "plc", "rs485-ports", "sensors", "sensors-gateway", "users", "vbox"], "no item lost; only mqtt-payload, plc and vbox added, the other keys (= routes) unchanged");
  for (const [k, page] of [["sensors", "SensorsPage"], ["farm-structure", "StructurePage"], ["rs485-ports", "PortsPage"], ["sensors-gateway", "GatewayPage"], ["mqtt-payload", "MqttPayloadPage"], ["plc", "PlcPage"], ["farm-profile", "FarmProfilePage"], ["users", "UsersPage"], ["backup", "BackupPage"]]) assert.match(st, new RegExp(`t === "${k}" \\? .*<${page}`), `#/settings/${k} opens ${page}`);
  assert.match(sb, /LEGACY: Record<string, string> = \{ gateway: "sensors-gateway", structure: "farm-structure", profile: "farm-profile" \}/);
  assert.match(sb, /aria-current=\{cur === "settings" && tab === k \? "page"/, "the item is highlighted by its route key, inside whichever group holds it");
  assert.match(sb, /go\("\/settings\/" \+ k\)/); assert.match(ab, /go\(to\)/); assert.match(ab, /"\/settings\/" \+ k/);
  assert.match(st, /go\("\/settings\/farm-profile"\)/, "bare #/settings still lands on Farm Profile on desktop");
});

test("PLC and V-BOX (2026-11-18): between SENSORS GATEWAY and MQTT PAYLOAD; locked but visible on FREE (sidebar and MORE sheet share the badges); V-BOX opens the MQTT Payload page on its V-BOX tab", () => {
  const body = sb.slice(sb.indexOf("export const GROUPS"), sb.indexOf("export const TABS"));
  assert.ok(body.indexOf('"sensors-gateway"') < body.indexOf('["plc", "PLC"]') && body.indexOf('["plc", "PLC"]') < body.indexOf('["vbox", "V-BOX"]') && body.indexOf('["vbox", "V-BOX"]') < body.indexOf('"mqtt-payload"'));
  assert.match(sb, /\/data-sources\/access/); assert.match(sb, /b\.plc = \{ tone: "off", word: "LOCKED", lock: true \}/); assert.match(sb, /b\.vbox = \{ tone: "off", word: "LOCKED", lock: true \}/);
  assert.match(ab, /badges\[k\]/, "the MORE sheet shows the same lock badges");
  assert.match(st, /t === "vbox" \? <MqttPayloadPage key="vbox" readOnly=\{!admin\} initialTab="vbox" \/>/);
  const mq = readFileSync("web/src/MqttPayloadPage.tsx", "utf8");
  for (const w of ["ALL MESSAGES", "V-BOX", "OTHER DEVICES", "MQTT PAYLOAD · V-BOX"]) assert.ok(mq.includes(w), w);
  assert.match(mq, /readOnly \? "all" : initialTab/, "Operators get the plain read-only page, no V-BOX tab");
  const lock = readFileSync("web/src/DataSourceLock.tsx", "utf8"); assert.match(lock, /GO TO ABOUT/); assert.match(lock, /go\("\/about"\)/);
  const vb = readFileSync("web/src/VboxTab.tsx", "utf8"), order = ["V-BOX PRESET", "V-BOX UNITS FOUND", "PAYLOAD MAPPING · V-BOX TAGS", "LATEST MESSAGES · V-BOX"].map((x) => vb.indexOf(x)); assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "V-BOX cards in the approved order");
});
