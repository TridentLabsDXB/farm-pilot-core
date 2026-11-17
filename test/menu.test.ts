import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// Menu structure of 2026-11-17 (source checks, same style as control.test.ts / about.test.ts): Admin sees ALARMS, MONITORING, CONTROL and the groups
// SETTINGS, DATA POINTS, SYSTEM, ABOUT pinned at the bottom; Operators get no group headings; every old settings route still opens its page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8");
const groups = (() => { const body = sb.slice(sb.indexOf("export const GROUPS"), sb.indexOf("export const TABS")); return [...body.matchAll(/title: "([^"]+)", tabs: \[((?:\["[^"]+", "[^"]+"\],? ?)+)\]/g)].map((m) => ({ title: m[1], tabs: [...m[2].matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((t) => t[1]) })); })();

test("Admin groups and their order: SETTINGS, DATA POINTS, SYSTEM", () => {
  assert.deepEqual(groups, [
    { title: "Settings", tabs: ["farm-profile", "farm-structure"] },
    { title: "Data points", tabs: ["rs485-ports", "sensors-gateway", "sensors"] },
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
  assert.match(app, /page === "settings" && admin \? "settings"/); assert.match(app, /me\.role !== "admin" && page === "settings"\) go\("\/monitoring"\)/);
});

test("Phone: bottom nav ALARMS, MONITORING, CONTROL, MORE for both roles; the MORE sheet shows the same groups (with badges) and ABOUT; the old phone Settings list leads to it", () => {
  assert.ok(!/>SETTINGS<\/button>/.test(app)); assert.match(app, /onClick=\{\(\) => go\("\/more"\)\}>MORE<\/button>/); assert.match(app, /cur === "more" \|\| cur === "about" \|\| cur === "settings"/);
  assert.match(app, /<MorePage admin=\{admin\} badges=\{badges\}/); assert.match(ab, /GROUPS\.filter/); assert.match(ab, /badges\[k\]/);
  assert.match(st, /phone && !t\) return <Redirect to="\/more" \/>/);
});

test("Every old settings route still opens its page and is highlighted under its new group", () => {
  const all = groups.flatMap((g) => g.tabs).sort();
  assert.deepEqual(all, ["backup", "farm-profile", "farm-structure", "rs485-ports", "sensors", "sensors-gateway", "users"], "no item lost or added, keys (= routes) unchanged");
  for (const [k, page] of [["sensors", "SensorsPage"], ["farm-structure", "StructurePage"], ["rs485-ports", "PortsPage"], ["sensors-gateway", "GatewayPage"], ["farm-profile", "FarmProfilePage"], ["users", "UsersPage"], ["backup", "BackupPage"]]) assert.match(st, new RegExp(`t === "${k}" \\? .*<${page}`), `#/settings/${k} opens ${page}`);
  assert.match(sb, /LEGACY: Record<string, string> = \{ gateway: "sensors-gateway", structure: "farm-structure", profile: "farm-profile" \}/);
  assert.match(sb, /aria-current=\{cur === "settings" && tab === k \? "page"/, "the item is highlighted by its route key, inside whichever group holds it");
  assert.match(sb, /go\("\/settings\/" \+ k\)/); assert.match(ab, /go\(to\)/); assert.match(ab, /"\/settings\/" \+ k/);
  assert.match(st, /go\("\/settings\/farm-profile"\)/, "bare #/settings still lands on Farm Profile on desktop");
});
