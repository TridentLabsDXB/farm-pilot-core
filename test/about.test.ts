// About page, Step 1: branding, build label, Device ID, host details (Linux real + Windows with injected sources), API access per role, bundled notices, UI wiring.
import { test, after } from "node:test"; import assert from "node:assert/strict";
import { createHash } from "node:crypto"; import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadBranding, BRANDING_DEFAULTS } from "../src/about/branding.js"; import { buildLabel, readBuild } from "../src/about/build.js";
import { deviceIdFromMachineId, readMachineId, thisDeviceId, DEVICE_ID_RE } from "../src/licence/device.js"; import { computerInfo, osName, ipv4Addresses, VIRTUAL_IFACE } from "../src/about/host.js";
import { FREE_LICENCE } from "../src/licence/free.js"; import { openDb } from "../src/db.js";
import { rig } from "./rig.js";
// @ts-ignore plain .mjs scripts without types
import { makeStamp } from "../scripts/build-stamp.mjs"; // @ts-ignore
import { buildNotices } from "../scripts/gen-notices.mjs";

const closers: (() => unknown)[] = []; after(() => Promise.all(closers.map((c) => c())));
const tmp = () => mkdtempSync(join(tmpdir(), "fp-about-"));

test("branding: defaults when the file is missing or broken, strings from config/branding.yaml, junk values ignored", () => {
  assert.deepEqual(loadBranding("/no/such/file.yaml"), BRANDING_DEFAULTS);
  const real = loadBranding("config/branding.yaml"); assert.equal(real.product_name, "FARM-PILOT CORE"); assert.equal(real.credit_line, "Engineered in the UAE by Trident Labs");
  const d = tmp(); writeFileSync(join(d, "b.yaml"), "product_name: ACME GREENHOUSE\ntagline: 5\ncredit_line: ''\nsupport_contact: call 123\n");
  assert.deepEqual(loadBranding(join(d, "b.yaml")), { ...BRANDING_DEFAULTS, product_name: "ACME GREENHOUSE", support_contact: "call 123" });
  writeFileSync(join(d, "bad.yaml"), ": : [unclosed"); assert.deepEqual(loadBranding(join(d, "bad.yaml")), BRANDING_DEFAULTS);
});

test("build label: one function; reads BUILD.json and the old BUILD file; -dirty detected; RELEASE stamp refuses a dirty tree", () => {
  assert.equal(buildLabel("0.1.0", "d4d82c4"), "v0.1.0 · build d4d82c4"); assert.equal(buildLabel("0.1.0", "unknown"), "v0.1.0"); assert.equal(buildLabel("", "unknown"), "");
  const root = tmp(), dist = join(root, "dist"); writeFileSync(join(root, "package.json"), '{"version":"2.3.4"}'); require_mkdir(dist);
  writeFileSync(join(dist, "BUILD.json"), JSON.stringify({ build: "abc1234", released: "2026-11-16", dirty: false }));
  assert.deepEqual(readBuild(dist, root), { version: "2.3.4", build: "abc1234", released: "2026-11-16", dirty: false, release: false, label: "v2.3.4 · build abc1234" });
  const old = tmp(); require_mkdir(join(old, "dist")); writeFileSync(join(old, "package.json"), '{"version":"1.0.0"}'); writeFileSync(join(old, "dist", "BUILD"), "ffff000-dirty\n");
  const r = readBuild(join(old, "dist"), old); assert.equal(r.build, "ffff000-dirty"); assert.equal(r.dirty, true); assert.equal(r.released, null);
  assert.deepEqual(makeStamp({ hash: "abc1234", dirty: false, release: true, now: new Date("2026-11-16T10:00:00Z") }), { build: "abc1234", released: "2026-11-16", dirty: false, release: true });
  assert.equal(makeStamp({ hash: "abc1234", dirty: true, release: false }).build, "abc1234-dirty");
  assert.throws(() => makeStamp({ hash: "abc1234", dirty: true, release: true }), /RELEASE build refused/);
  for (const s of [makeStamp({ hash: "abc1234", dirty: false, release: true })]) assert.ok(!/dirty/i.test(s.build));
});
function require_mkdir(p: string) { mkdirSync(p, { recursive: true }); }

test("Device ID: format FP-XXXX-XXXX-XXXX, SHA-256 of 'farmpilot-core|'+machine id, stable, case and whitespace independent", () => {
  const mid = "0123456789abcdef0123456789abcdef", want = createHash("sha256").update("farmpilot-core|" + mid).digest("hex").slice(0, 12).toUpperCase();
  const id = deviceIdFromMachineId(mid); assert.equal(id, `FP-${want.slice(0, 4)}-${want.slice(4, 8)}-${want.slice(8)}`); assert.match(id, DEVICE_ID_RE);
  assert.equal(deviceIdFromMachineId(mid.toUpperCase() + "\n"), id); assert.notEqual(deviceIdFromMachineId(mid.replace("0", "1")), id);
  assert.equal(thisDeviceId("linux", { readFile: () => mid + "\n" }), id); assert.equal(thisDeviceId("linux", { readFile: () => mid + "\n" }), id, "stable across calls (restarts)");
});
test("Device ID machine id: Linux /etc/machine-id with dbus fallback; Windows MachineGuid from reg.exe output; unreadable gives null", () => {
  const seen: string[] = []; assert.equal(readMachineId("linux", { readFile: (p) => { seen.push(p); if (p === "/etc/machine-id") throw new Error("ENOENT"); return "aaaaaaaabbbbbbbbccccccccdddddddd"; } }), "aaaaaaaabbbbbbbbccccccccdddddddd"); assert.deepEqual(seen, ["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  assert.equal(readMachineId("linux", { readFile: () => { throw new Error("none"); } }), null); assert.equal(readMachineId("linux", { readFile: () => "short" }), null);
  const guid = "4C4C4544-0042-5710-8052-B3C04F4B4E32"; let call: string[] = [];
  const reg = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    " + guid + "\r\n\r\n";
  assert.equal(readMachineId("win32", { run: (f, a) => { call = [f, ...a]; return reg; } }), guid); assert.deepEqual(call, ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
  assert.match(thisDeviceId("win32", { run: () => reg })!, DEVICE_ID_RE); assert.equal(thisDeviceId("win32", { run: () => { throw new Error("reg failed"); } }), null);
  assert.equal(thisDeviceId("win32", { run: () => reg }), deviceIdFromMachineId(guid.toLowerCase()), "GUID case does not change the ID");
});

test("THIS COMPUTER on Linux: all 12 values come from the real host", async () => {
  const db = openDb(":memory:"); const c = await computerInfo(db, { dataDir: tmpdir(), dbPath: "/no/db", timezone: "Asia/Dubai" }, { serialPorts: async () => ["/dev/ttyUSB0"] });
  assert.ok(c.computer_name && c.operating_system.includes("Linux") && c.cpu && c.memory_total_bytes > c.memory_used_bytes && c.memory_used_bytes > 0, JSON.stringify(c));
  assert.ok((c.disk_free_bytes ?? 0) > 0 && (c.disk_total_bytes ?? 0) >= c.disk_free_bytes!, "disk free of the data volume"); assert.ok(c.uptime_s > 0);
  assert.equal(c.time_zone, "Asia/Dubai"); assert.equal(c.node_version, process.version); assert.match(c.sqlite_version, /^\d+\.\d+\.\d+/); assert.equal(c.database_bytes, null, "missing db file is shown as --");
  assert.deepEqual(c.serial_ports, ["/dev/ttyUSB0"]); assert.equal(c.data_folder, tmpdir()); for (const ip of c.ip_addresses) assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
});
test("THIS COMPUTER on Windows (injected sources): registry wording, Windows 11 quirk, drive-letter disk, COM ports, no crash when reg.exe fails", async () => {
  const db = openDb(":memory:"); const winOs = { hostname: () => "FARM-PC", version: () => "Windows 10 Pro", release: () => "10.0.22631", cpus: () => [{ model: "Intel(R) Core(TM) i5-1235U" }, { model: "x" }] as any, totalmem: () => 16e9, freemem: () => 6e9, uptime: () => 90061, networkInterfaces: () => ({ Ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.20" }, { family: "IPv6", internal: false, address: "fe80::1" }], Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] }) as any };
  const reg = "    ProductName    REG_SZ    Windows 10 Pro\r\n    DisplayVersion    REG_SZ    23H2\r\n    CurrentBuildNumber    REG_SZ    22631\r\n";
  const asked: string[] = [];
  const c = await computerInfo(db, { dataDir: "C:\\FarmPilot-Core\\data", dbPath: "C:\\FarmPilot-Core\\data\\core.db" }, { platform: "win32", os: winOs, run: (f, a) => { asked.push(`${f} ${a.join(" ")}`); return reg; }, statfs: async (p) => { asked.push("statfs " + p); return { bsize: 4096, bavail: 1e6, blocks: 4e6 }; }, fileSize: (p) => (p.endsWith("-wal") ? 1000 : 5000), serialPorts: async () => ["COM3", "COM4"] });
  assert.equal(c.operating_system, "Windows 11 Pro 23H2 (build 22631)"); assert.equal(c.computer_name, "FARM-PC"); assert.equal(c.cpu, "Intel(R) Core(TM) i5-1235U x2"); assert.deepEqual(c.ip_addresses, ["192.168.1.20"]);
  assert.equal(c.disk_free_bytes, 4096e6); assert.equal(c.disk_total_bytes, 4096 * 4e6); assert.equal(c.database_bytes, 6000); assert.deepEqual(c.serial_ports, ["COM3", "COM4"]); assert.equal(c.data_folder, "C:\\FarmPilot-Core\\data"); assert.equal(c.uptime_s, 90061);
  assert.ok(asked.includes("statfs C:\\FarmPilot-Core\\data")); assert.ok(asked.some((x) => x.startsWith("reg query HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")));
  assert.equal(osName({ platform: "win32", os: winOs, run: () => { throw new Error("no reg"); } }), "Windows 11 Pro (build 22631)", "reg.exe failing falls back to os.version()");
  assert.equal(osName({ platform: "win32", os: { ...winOs, version: () => "" }, run: () => reg }), "Windows 11 Pro 23H2 (build 22631)", "empty os.version(): the registry ProductName is used");
});

test("API /api/about: Operator gets product, version, build, licence summary with usage, uptime and NO Device ID or host details; Admin gets both; computer route is Admin only", async () => {
  const x = await rig(); closers.push(x.close);
  x.db.prepare("INSERT INTO sensors(serial,type,slot,reporting_interval,created_at) VALUES('112600310','th',1,5,1),('112600311','th',2,5,1)").run();
  assert.equal((await x.call(null, "GET", "/api/about")).status, 401);
  const op = await x.call(x.op, "GET", "/api/about"); assert.equal(op.status, 200); const o = op.json;
  assert.equal(o.product, "FARM-PILOT CORE"); assert.equal(o.credit_line, "Engineered in the UAE by Trident Labs"); assert.equal(typeof o.version, "string"); assert.equal(typeof o.uptime_s, "number");
  assert.equal(o.licence.type, "FREE"); assert.equal(o.licence.state, "FREE"); assert.equal(o.licence.licensed_to, null); assert.equal(o.licence.valid_until, null);
  assert.deepEqual(o.licence.limits, { gateways: FREE_LICENCE.gateways, sensors: FREE_LICENCE.sensors }); assert.deepEqual(o.licence.usage, { gateways: 0, sensors: 2 }); assert.equal(o.licence.over_limit, false);
  assert.ok(!("device_id" in o) && !("computer" in o), "keys absent for an Operator"); const dev = (await import("../src/licence/device.js")).thisDeviceId();
  for (const secret of [dev, "data_folder", "serial_ports", "sqlite_version", (await import("node:os")).hostname()]) if (secret) assert.ok(!op.txt.includes(secret), `Operator response must not contain ${secret}`);
  assert.equal((await x.call(x.op, "GET", "/api/about/computer")).status, 403);
  const ad = (await x.call(x.admin, "GET", "/api/about")).json; assert.ok(ad.computer && ad.computer.computer_name && ad.computer.sqlite_version); if (dev) assert.equal(ad.device_id, dev);
  const comp = await x.call(x.admin, "GET", "/api/about/computer"); assert.equal(comp.status, 200); assert.equal(comp.json.node_version, process.version);
  const h = (await x.call(null, "GET", "/api/health")).json; assert.equal(h.build_label, ad.label, "login footer and About print the same build label"); assert.equal(h.version, ad.version); assert.equal(h.build, ad.build);
});

test("bundled notices: generated from production dependencies only, CHANGELOG exists, files are plain text", () => {
  const n = buildNotices(["."]) as string; assert.match(n, /^FARM-PILOT CORE: third-party notices/); assert.match(n, /\nfastify \d/); assert.match(n, /\nbetter-sqlite3 \d/); assert.ok(!/\ntypescript \d/.test(n) && !/\ntsx \d/.test(n), "dev-only packages are not listed");
  assert.match(n, /MIT/); assert.match(readFileSync("CHANGELOG.md", "utf8"), /^# FARM-PILOT CORE release notes/);
});

test("UI wiring (source): ABOUT in the sidebar above the version caption, route /about, MORE sheet on the phone (ABOUT row for everyone, after the Admin groups), same build label as the login footer, three breakpoints", () => {
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), st = readFileSync("web/src/Settings.tsx", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8"), css = readFileSync("web/src/about.css", "utf8"), login = readFileSync("web/src/Login.tsx", "utf8");
  assert.ok(sb.indexOf(">ABOUT</button>") > 0 && sb.indexOf(">ABOUT</button>") < sb.indexOf("fp-sb-ver"), "ABOUT above the caption"); assert.match(sb, /FARM-PILOT CORE\{version \? ` · v\$\{version\}` : ""\}/);
  assert.match(app, /page === "about" \? "about"/); assert.match(app, />MORE<\/button>/); assert.match(ab, /row\("about", "ABOUT", "\/about"\)/); assert.ok(!/ABOUT/.test(st), "Settings no longer carries an ABOUT row");
  assert.match(ab, /alt="Farm Pilot CORE logo"/); assert.match(ab, /farm-pilot-core-logo-512\.png/); for (const k of ["RELEASE NOTES", "NOTICES", "VERSION", "BUILD", "RELEASED", "LICENCE", "THIS COMPUTER", "COMPUTER NAME", "OPERATING SYSTEM", "DISK FREE", "SERIAL PORTS", "DATA FOLDER", "refreshed", "OVER LIMIT", "Not activated", "No expiry"]) assert.ok(ab.includes(k), k);
  assert.match(ab, /setInterval\(load, 10_000\)/); assert.ok(!/build-label|info\.label/.test(ab), "no duplicate build label line under the tiles"); assert.match(login, /h\.build_label/);
  assert.match(css, /max-width: 1023px/); assert.match(css, /max-width: 767px/); assert.match(css, /grid-template-columns: 380px/); assert.match(css, /\.ab-logo \{ width: 230px/); assert.match(css, /data-theme="dark"\] \.ab-logo \{ filter: drop-shadow/);
  assert.ok(!/https?:\/\//.test(ab.replace(/\/\/.*$/gm, "")), "no external requests");
});

test("IP addresses survive os.networkInterfaces() failing (EAFNOSUPPORT under the systemd unit): fallback to /proc/net/fib_trie, never throws", () => {
  const boom = { networkInterfaces: () => { throw new Error("uv_interface_addresses returned Unknown system error 97"); } };
  const trie = "Main:\n  +-- 0.0.0.0/0 3 0 5\n     |-- 10.0.0.3\n        /32 host LOCAL\n     |-- 10.0.0.255\n        /32 link BROADCAST\n     |-- 127.0.0.1\n        /32 host LOCAL\n     |-- 172.17.0.1\n        /32 host LOCAL\n";
  assert.deepEqual(ipv4Addresses(boom as any, () => trie), ["10.0.0.3", "172.17.0.1"]); assert.deepEqual(ipv4Addresses(boom as any, () => { throw new Error("no proc"); }), []);
});

test("fault tolerance: one failing source gives null for THAT field only (UI says unavailable); every source can fail at once without throwing; Windows sources too", async () => {
  const db = openDb(":memory:"); const boom = () => { throw new Error("source failed"); };
  const okOs = { hostname: () => "H", version: () => "v", release: () => "1", cpus: () => [{ model: "CPU" }] as any, totalmem: () => 8e9, freemem: () => 2e9, uptime: () => 100, networkInterfaces: () => ({}) as any };
  const base = { dataDir: tmpdir(), dbPath: "/no/db", timezone: "Asia/Dubai" };
  for (const platform of ["linux", "win32"] as const) {
    const all = await computerInfo(db, base, { platform, os: okOs }); assert.equal(all.computer_name, "H"); assert.equal(all.cpu, "CPU x1");
    const cases: [keyof typeof okOs, string[]][] = [["hostname", ["computer_name"]], ["cpus", ["cpu"]], ["totalmem", ["memory_used_bytes", "memory_total_bytes"]], ["freemem", ["memory_used_bytes"]], ["uptime", ["uptime_s"]], ["networkInterfaces", ["ip_addresses"]]];
    for (const [fn, fields] of cases) { const c: any = await computerInfo(db, base, { platform, os: { ...okOs, [fn]: boom }, readFile: boom }); for (const f of fields) if (!(fn === "networkInterfaces" && f === "ip_addresses")) assert.equal(c[f], null, `${platform}: ${fn} failing must null ${f}`); assert.equal(c.node_version, process.version, "other fields survive"); assert.equal(c.sqlite_version.length > 0, true); }
    const d = await computerInfo(db, base, { platform, os: okOs, statfs: async () => { throw new Error("no disk"); }, serialPorts: async () => { throw new Error("no ports"); }, fileSize: boom, run: boom });
    assert.equal(d.disk_free_bytes, null); assert.equal(d.disk_total_bytes, null); assert.equal(d.serial_ports, null); assert.equal(d.database_bytes, null); assert.equal(d.computer_name, "H");
    const dead: any = await computerInfo({ prepare: boom } as any, base, { platform, os: { hostname: boom, version: boom, release: boom, cpus: boom, totalmem: boom, freemem: boom, uptime: boom, networkInterfaces: boom } as any, run: boom, readFile: boom, statfs: boom as any, fileSize: boom, serialPorts: boom as any });
    for (const k of ["computer_name", "cpu", "memory_used_bytes", "memory_total_bytes", "disk_free_bytes", "uptime_s", "sqlite_version", "database_bytes", "serial_ports"]) assert.equal(dead[k], null, `${platform} ${k}`); assert.ok(dead.operating_system === null || typeof dead.operating_system === "string");
  }
  const x = await rig(); closers.push(x.close); const r = await x.call(x.admin, "GET", "/api/about/computer"); assert.equal(r.status, 200);
});
test("IP list: docker, bridge, veth, virbr, lo, VM and link-local addresses are hidden (os call and /proc fallback)", () => {
  for (const n of ["lo", "docker0", "docker_gwbridge", "br-3f2a1c", "veth12ab", "virbr0", "vEthernet (Default Switch)", "VMware Network Adapter VMnet8", "VirtualBox Host-Only Network", "Loopback Pseudo-Interface 1", "cni0"]) assert.match(n, VIRTUAL_IFACE, n);
  for (const n of ["eth0", "ens3", "enp0s31f6", "wlan0", "wg0", "br0", "Ethernet", "Wi-Fi"]) assert.doesNotMatch(n, VIRTUAL_IFACE, n);
  const a = (address: string, internal = false) => ({ family: "IPv4", internal, address });
  const os = { networkInterfaces: () => ({ lo: [a("127.0.0.1", true)], eth0: [a("192.168.1.20"), { family: "IPv6", internal: false, address: "fe80::1" }], docker0: [a("172.17.0.1")], "br-abc": [a("172.18.0.1")], veth1: [a("10.9.9.9")], wlan0: [a("169.254.3.4")], wg0: [a("10.0.0.3")] }) as any };
  assert.deepEqual(ipv4Addresses(os, () => ""), ["192.168.1.20", "10.0.0.3"]);
  const trie = "     |-- 10.0.0.3\n        /32 host LOCAL\n     |-- 172.17.0.1\n        /32 host LOCAL\n     |-- 192.168.1.20\n        /32 host LOCAL\n     |-- 169.254.1.1\n        /32 host LOCAL\n     |-- 127.0.0.1\n        /32 host LOCAL\n";
  const le = (ip: string) => Buffer.from(ip.split(".").map(Number)).readUInt32LE(0).toString(16).toUpperCase().padStart(8, "0"); /* real /proc/net/route format: little-endian u32 as hex (192.168.1.0 -> 0001A8C0) */ const route = `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n docker0\t${le("172.17.0.0")}\t00000000\t0001\t0\t0\t0\t${le("255.255.0.0")}\n eth0\t${le("192.168.1.0")}\t00000000\t0001\t0\t0\t0\t${le("255.255.255.0")}\n wg0\t${le("10.0.0.0")}\t00000000\t0001\t0\t0\t0\t${le("255.255.255.0")}\n`;
  const boom = { networkInterfaces: () => { throw new Error("97"); } } as any;
  assert.deepEqual(ipv4Addresses(boom, (p) => (p.endsWith("fib_trie") ? trie : route)).sort(), ["10.0.0.3", "192.168.1.20"], "fallback maps addresses to interfaces through /proc/net/route");
});
test("UI polish (source): RELEASED nowrap, chooser text in page font, sidebar compact and pinned ABOUT on short screens, identity card stretches", () => {
  const css = readFileSync("web/src/about.css", "utf8"), core = readFileSync("web/src/core.css", "utf8"), ab = readFileSync("web/src/About.tsx", "utf8");
  assert.match(css, /data-nowrap="1"\] \.ab-val \{ white-space: nowrap/); assert.match(css, /\.ab-chosen \{ font-family: var\(--fp-mono\)/); assert.match(css, /align-items: stretch/); assert.match(ab, /unavailable/);
  assert.match(core, /\.fp-sb-bottom \{[^}]*position: sticky; bottom: -16px/); assert.match(core, /max-height: 860px\)[\s\S]*\.fp-sb-brand img \{ width: 48px/);
});
