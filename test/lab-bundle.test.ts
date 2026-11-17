import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-17 -- Windows lab bundle: check.mjs logic (runs on Linux with the platform passed in), upgrade.mjs / rollback on a temporary folder tree, and the contract of the bundle scripts
// (top folder FarmPilot-Core\app, no "FarmPilotCore" path left, the README-LAB checklist). Nothing here needs Windows; what does is listed in the delivery report.
import { test } from "node:test"; import assert from "node:assert/strict"; import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import net from "node:net"; import { createRequire } from "node:module"; import { execFileSync } from "node:child_process";
// @ts-ignore plain .mjs without types
import { parseEnvFile, classifyDrive, dataDriveKind, portFree, runChecks, render } from "../deploy/windows/check.mjs";
// @ts-ignore plain .mjs without types
import { upgrade, rollback, backupDb } from "../deploy/windows/upgrade.mjs";
const require = createRequire(import.meta.url); const Database = require("better-sqlite3"); const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("check: core.env parsing, drive classification (removable, USB, network, fixed, unknown), UNC refusal, PowerShell failure is 'unknown' not a crash", () => {
  assert.deepEqual(parseEnvFile("# c\r\nPORT=4101\r\nHOST_BIND_IP = 0.0.0.0\nDATA_DIR=\"D:\\x y\"\nbad line\n"), { PORT: "4101", HOST_BIND_IP: "0.0.0.0", DATA_DIR: "D:\\x y" });
  assert.equal(classifyDrive("type=2;bus=USB").ok, false); assert.equal(classifyDrive("type=3;bus=USB").ok, false); assert.match(classifyDrive("type=3;bus=USB").text, /USB/); assert.equal(classifyDrive("type=4;bus=").ok, false);
  assert.deepEqual(classifyDrive("type=3;bus=SATA"), { ok: true, text: "fixed local disk (SATA)" }); assert.equal(classifyDrive("type=3;bus=").ok, true); assert.equal(classifyDrive("").ok, null);
  let asked = ""; assert.equal(dataDriveKind("E:\\FarmPilot-Core\\data", "win32", (_f: string, a: string[]) => { asked = a.join(" "); return "type=2;bus=USB"; }).ok, false); assert.match(asked, /DeviceID='E:'/);
  assert.equal(dataDriveKind("C:\\FarmPilot-Core\\data", "win32", () => "type=3;bus=SATA").ok, true); assert.equal(dataDriveKind("\\\\nas\\share\\data", "win32", () => { throw new Error("must not be asked"); }).ok, false);
  assert.equal(dataDriveKind("C:\\x", "win32", () => { throw new Error("no powershell"); }).ok, null); assert.equal(dataDriveKind("/var/lib/x", "linux").ok, true);
});

test("check: port free / in use", async () => {
  const s = net.createServer(); await new Promise<void>((r) => s.listen(0, "0.0.0.0", () => r())); const port = (s.address() as net.AddressInfo).port;
  assert.deepEqual(await portFree(port), { ok: false, code: "EADDRINUSE" }); await new Promise((r) => s.close(r)); assert.equal((await portFree(port)).ok, true);
});

test("check: full run against the built program with the platform passed as win32/x64 - every item reported, writes only temp files, 'All checks passed.' with a removable-drive refusal when the drive says so", { timeout: 120_000 }, async () => {
  // compile the server into a TEMP dist (never the live /opt/farmpilot-core/dist) so the check runs against the code of THIS commit
  const app = tmp("fp-app-"); execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", ".", "--outDir", join(app, "dist"), "--incremental", "false", "--tsBuildInfoFile", "null"], { stdio: "pipe" }); writeFileSync(join(app, "dist", "BUILD"), "test123\n"); writeFileSync(join(app, "dist", "BUILD.json"), JSON.stringify({ build: "test123", released: "2026-11-17", dirty: false, release: false }));
  const data = tmp("fp-chk-"), env = { DATA_DIR: data, PORT: "0" };
  const r = await runChecks({ appDir: app, env, platform: "win32", arch: "x64", drive: () => classifyDrive("type=3;bus=SATA") }); const names = r.results.map((x: any) => x.name);
  for (const n of ["Node version", "Native module better-sqlite3", "Native module serialport", "Data folder writable", "Data drive is internal", "SQLite write test on the data volume", "Serial ports", "Licence", "Time zone and clock"]) assert.ok(names.includes(n), n);
  assert.ok(names.some((n: string) => /^Port \d+ is free$/.test(n)));
  const txt = render(r); const failedNames = r.results.filter((x: any) => !x.ok && !x.warn).map((x: any) => x.name); assert.deepEqual(failedNames, [], txt.text); assert.match(txt.text, /All checks passed\./); assert.equal(txt.failed, 0);
  assert.deepEqual(readdirSync(data), [], "the write test and the SQLite test database are removed again"); assert.match(r.results.find((x: any) => x.name === "Licence").text, /FREE \(no licence file/);
  const bad = render(await runChecks({ appDir: app, env, platform: "win32", arch: "x64", drive: () => classifyDrive("type=2;bus=USB") })); assert.equal(bad.failed, 1); assert.match(bad.text, /FAIL  Data drive is internal: removable drive/); assert.match(bad.text, /1 check\(s\) FAILED: Data drive is internal/);
  const lin = render(await runChecks({ appDir: app, env, platform: "linux", arch: "x64" })); assert.match(lin.text, /FAIL  Node version/, "not Windows x64 is a FAIL, the run does not prove the Windows binaries");
});

// ---- upgrade / rollback on a temporary base folder ----
function mkApp(dir: string, version: string, build: string) { mkdirSync(join(dir, "dist"), { recursive: true }); mkdirSync(join(dir, "node"), { recursive: true }); writeFileSync(join(dir, "dist", "index.js"), "// " + build); writeFileSync(join(dir, "dist", "BUILD"), build + "\n"); writeFileSync(join(dir, "node", "node.exe"), "x"); writeFileSync(join(dir, "package.json"), JSON.stringify({ version })); writeFileSync(join(dir, "check.mjs"), ""); }
function mkBase() { const base = tmp("fp-upg-"); mkApp(join(base, "app"), "0.1.0", "aaaaaaa"); mkdirSync(join(base, "data"), { recursive: true }); const db = new Database(join(base, "data", "core.db")); db.pragma("journal_mode = WAL"); db.exec("create table t(a); insert into t values (1),(2),(3)"); db.close(); writeFileSync(join(base, "core.env"), "PORT=4100\n");
  const zipSrc = tmp("fp-zip-"); mkApp(join(zipSrc, "FarmPilot-Core", "app"), "0.1.1", "bbbbbbb"); return { base, zipSrc, zip: join(zipSrc, "fake.zip") }; }
const deps = (x: { zipSrc: string }, over: any = {}) => ({ log: () => {}, Database, isRunning: () => false, extract: (_z: string, dir: string) => cpSync(x.zipSrc, dir, { recursive: true, filter: (s: string) => !s.endsWith("fake.zip") }), checkNew: () => [] as string[], ...over });
const rows = (f: string) => { const d = new Database(f, { readonly: true }); try { return d.prepare("select count(*) n from t").get().n; } finally { d.close(); } };

test("upgrade: database copied first (VACUUM INTO + integrity ok), old program kept as app.prev, new one in place, data and core.env untouched, last-upgrade.json written", () => {
  const x = mkBase(); writeFileSync(x.zip, "z"); const r = upgrade({ base: x.base, zip: x.zip, deps: deps(x) });
  assert.equal(readFileSync(join(x.base, "app", "dist", "BUILD"), "utf8").trim(), "bbbbbbb"); assert.equal(readFileSync(join(x.base, "app.prev", "dist", "BUILD"), "utf8").trim(), "aaaaaaa");
  assert.equal(rows(join(r.backup!, "core.db")), 3); assert.equal(rows(join(x.base, "data", "core.db")), 3); assert.equal(readFileSync(join(x.base, "core.env"), "utf8"), "PORT=4100\n"); assert.ok(!existsSync(join(x.base, "upgrade-tmp")));
  const li = JSON.parse(readFileSync(join(x.base, "backups", "last-upgrade.json"), "utf8")); assert.deepEqual([li.from.build, li.to.build, li.from.version, li.to.version], ["aaaaaaa", "bbbbbbb", "0.1.0", "0.1.1"]);
});
test("upgrade refuses without touching anything: CORE running, zip missing, not a lab bundle, new self-test failing", () => {
  const x = mkBase(); writeFileSync(x.zip, "z"); const still = () => assert.equal(readFileSync(join(x.base, "app", "dist", "BUILD"), "utf8").trim(), "aaaaaaa") && assert.ok(!existsSync(join(x.base, "app.prev")));
  assert.throws(() => upgrade({ base: x.base, zip: x.zip, deps: deps(x, { isRunning: () => true }) }), /CORE is running/); still();
  assert.throws(() => upgrade({ base: x.base, zip: join(x.base, "nope.zip"), deps: deps(x) }), /not found/); still();
  assert.throws(() => upgrade({ base: x.base, zip: x.zip, deps: deps(x, { extract: (_z: string, d: string) => mkdirSync(join(d, "other"), { recursive: true }) }) }), /not a FarmPilot-Core lab bundle/); still();
  assert.throws(() => upgrade({ base: x.base, zip: x.zip, deps: deps(x, { checkNew: () => ["Native module serialport: did not load"] }) }), /failed its own self-test/); still(); assert.ok(!existsSync(join(x.base, "upgrade-tmp")));
});
test("rollback: old program back, pre-upgrade database restored, what was entered since is saved first; /keep-data leaves the database; refuses while running or without app.prev", () => {
  const x = mkBase(); writeFileSync(x.zip, "z"); assert.throws(() => rollback({ base: x.base, deps: deps(x) }), /no previous program/); upgrade({ base: x.base, zip: x.zip, deps: deps(x) });
  const d = new Database(join(x.base, "data", "core.db")); d.exec("insert into t values (4),(5)"); d.pragma("wal_checkpoint(TRUNCATE)"); d.close();
  assert.throws(() => rollback({ base: x.base, deps: deps(x, { isRunning: () => true }) }), /CORE is running/);
  const r = rollback({ base: x.base, deps: deps(x) }); assert.equal(r.restoredDb, true);
  assert.equal(readFileSync(join(x.base, "app", "dist", "BUILD"), "utf8").trim(), "aaaaaaa"); assert.equal(readFileSync(join(x.base, "app.rolled-back", "dist", "BUILD"), "utf8").trim(), "bbbbbbb"); assert.ok(!existsSync(join(x.base, "app.prev")));
  assert.equal(rows(join(x.base, "data", "core.db")), 3, "pre-upgrade copy is back"); const kept = readdirSync(join(x.base, "backups")).filter((n) => n.startsWith("before-rollback-")); assert.equal(kept.length, 1); assert.equal(rows(join(x.base, "backups", kept[0], "core.db")), 5, "the newer data is kept");
  const y = mkBase(); writeFileSync(y.zip, "z"); upgrade({ base: y.base, zip: y.zip, deps: deps(y) }); const e = new Database(join(y.base, "data", "core.db")); e.exec("insert into t values (9)"); e.close();
  assert.equal(rollback({ base: y.base, keepData: true, deps: deps(y) }).restoredDb, false); assert.equal(rows(join(y.base, "data", "core.db")), 4);
});
test("backupDb: a copy that is not a database fails the integrity step", () => { const d = tmp("fp-bk-"); const f = join(d, "core.db"); const db = new Database(f); db.exec("create table t(a)"); db.close(); backupDb(Database, f, join(d, "ok.db")); assert.throws(() => backupDb(Database, join(d, "missing.db"), join(d, "x.db"))); });

// ---- the bundle contract (source) ----
test("bundle scripts: top folder FarmPilot-Core\\app, no leftover FarmPilotCore path anywhere in the Windows files, tools/tests/.git/source maps excluded, build stamp is not a release", () => {
  const files = ["start-core.cmd", "deploy/windows/check.cmd", "deploy/windows/check.mjs", "deploy/windows/upgrade.cmd", "deploy/windows/upgrade.mjs", "deploy/windows/urls.mjs", "deploy/windows/serial-probe.cmd", "deploy/windows/serial-probe.mjs", "deploy/windows/README-LAB.txt", "deploy/windows/core.env.example"];
  for (const f of files) assert.ok(!/FarmPilotCore/.test(readFileSync(f, "utf8")), `${f} still mentions FarmPilotCore`);
  const sh = readFileSync("scripts/make-lab-bundle.sh", "utf8"); assert.deepEqual(sh.split("\n").filter((l) => /FarmPilotCore/.test(l) && !/grep -rIl "FarmPilotCore"|leftover FarmPilotCore|no leftover/.test(l)), [], "the build script only names the old folder inside its own leftover check"); assert.match(sh, /TOP="\$W\/FarmPilot-Core"; APP="\$TOP\/app"/); assert.match(sh, /farmpilot-core-lab-\$VERSION-\$SHA-win-x64\.zip/); assert.match(sh, /release: false/); assert.match(sh, /\*\.map/); assert.match(sh, /for bad in tools test \.git/); assert.match(sh, /assert tops == \{"FarmPilot-Core"\}/);
  assert.ok(!existsSync("scripts/make-windows-bundle.sh"), "the old bundle script (wrong top folder) is gone");
  const start = readFileSync("start-core.cmd", "utf8"); assert.match(start, /HOST_BIND_IP=0\.0\.0\.0/); assert.match(start, /urls\.mjs/); assert.match(start, /FARMPILOT_CORE_HOME=C:\\FarmPilot-Core/);
  const sh2 = readFileSync("scripts/make-lab-bundle.sh", "utf8"); assert.match(sh2, /serial-probe\.cmd "\$APP\/serial-probe\.cmd"/); assert.match(sh2, /serial-probe\.mjs "\$APP\/"/); assert.match(sh2, /check\.cmd serial-probe\.cmd serial-probe\.mjs/, "verified in the bundle");
  assert.match(readFileSync("deploy/windows/serial-probe.cmd", "utf8"), /serial-probe\.mjs" %\*/);
  const up = readFileSync("deploy/windows/upgrade.cmd", "utf8"); assert.match(up, /\/rollback/); assert.match(up, /%TEMP%\\fp-upgrade/);
});
test("README-LAB.txt: numbered first-run checklist with every step asked for, stop / data / logs / sleep, upgrade and rollback", () => {
  const t = readFileSync("deploy/windows/README-LAB.txt", "utf8"); assert.equal((t.match(/^ \[ \] \d+\./gm) ?? []).length, 12); assert.match(t, /^ \[ \] 4a\. Serial check without CORE/m); assert.match(t, /close every other program using the COM port/); assert.match(t, /serial-probe\.cmd COM11/); assert.match(t, /LOG_MODBUS=1/);
  for (const s of ["Unblock and unzip", "check.cmd", "start-core.cmd", "http://127.0.0.1:4100", "First login", "RS-485 PORTS", "TEST PORT", "Replug test", "COM10+ test", "Ctrl+C", "Sleep = Never", "initial-admin-password", "upgrade.cmd /rollback", "C:\\FarmPilot-Core\\logs\\core.log", "BOTH \"Private networks\" AND \"Public networks\"", "ipconfig", "192.168.137.1", "http://<tablet IP>:4100"]) assert.ok(t.includes(s), s);
});
