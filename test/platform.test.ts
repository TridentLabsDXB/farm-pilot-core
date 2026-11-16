// Windows port W1: platform defaults, admin-password ACL, shutdown signals. The Windows branches are tested on any OS by passing the platform in.
import { test } from "node:test"; import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { defaultPaths, restrictToCurrentUser, shutdownSignals, isWin } from "../src/platform.js";
import { writeInitialPassword } from "../src/auth.js";

test("defaults: Linux keeps the systemd layout, DATA_DIR and DB_PATH stay independent", () => {
  assert.deepEqual(defaultPaths("linux", {}), { dataDir: "/var/lib/farmpilot-core", dbPath: "/var/lib/farmpilot-core/core.db", logsDir: "/var/log/farmpilot-core", envFile: "/etc/farmpilot-core.env", serialPath: "/dev/ttyUSB0" });
  const o = defaultPaths("linux", { DATA_DIR: "/x", DB_PATH: "/y/a.db" }); assert.equal(o.dataDir, "/x"); assert.equal(o.dbPath, "/y/a.db");
  assert.equal(defaultPaths("linux", { DATA_DIR: "/x" }).dbPath, "/var/lib/farmpilot-core/core.db");   // unchanged old behaviour
});
test("defaults: Windows uses C:\\FarmPilot-Core (never C:\\FarmPilot), DATA_DIR moves the database with it, both overridable", () => {
  const w = defaultPaths("win32", {});
  assert.deepEqual(w, { dataDir: "C:\\FarmPilot-Core\\data", dbPath: "C:\\FarmPilot-Core\\data\\core.db", logsDir: "C:\\FarmPilot-Core\\logs", envFile: "C:\\FarmPilot-Core\\core.env", serialPath: "COM3" });
  assert.ok(!Object.values(w).some((v) => /^C:\\FarmPilot\\/.test(v)));
  assert.equal(defaultPaths("win32", { DATA_DIR: "D:\\d" }).dbPath, "D:\\d\\core.db");
  assert.equal(defaultPaths("win32", { DATA_DIR: "D:\\d", DB_PATH: "E:\\x.db" }).dbPath, "E:\\x.db");
  assert.equal(defaultPaths("win32", { FARMPILOT_CORE_HOME: "D:\\Core" }).logsDir, "D:\\Core\\logs");
});
test("shutdown signals: Windows adds SIGBREAK and SIGHUP and drops SIGTERM, Linux unchanged", () => {
  assert.deepEqual(shutdownSignals("linux"), ["SIGTERM", "SIGINT"]); assert.deepEqual(shutdownSignals("win32"), ["SIGINT", "SIGBREAK", "SIGHUP"]); assert.equal(isWin("darwin"), false);
});
test("ACL: icacls drops inheritance and grants only the current user; Linux never calls it", () => {
  const calls: string[][] = [];
  assert.equal(restrictToCurrentUser("C:\\FarmPilot-Core\\data\\initial-admin-password", "win32", (f, a) => { calls.push([f, ...a]); }, "PC\\owner"), true);
  assert.deepEqual(calls, [["icacls", "C:\\FarmPilot-Core\\data\\initial-admin-password", "/inheritance:r", "/grant:r", "PC\\owner:(F)"]]);
  assert.equal(restrictToCurrentUser("/x", "win32", () => { throw new Error("denied"); }, "u"), false);
  let n = 0; assert.equal(restrictToCurrentUser("/x", "linux", () => { n++; }), true); assert.equal(n, 0);
});
test("initial-admin-password: Linux mode 600 as before; Windows restricts BEFORE writing; on icacls failure no file and the password goes to the console once", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-pw-")); const f = join(dir, "pw");
  try {
    writeInitialPassword(f, "admin / s3cret\n", "linux"); assert.equal(readFileSync(f, "utf8"), "admin / s3cret\n"); if (process.platform !== "win32") assert.equal(statSync(f).mode & 0o777, 0o600); rmSync(f);
    let contentAtRestrict: string | null = null; writeInitialPassword(f, "admin / s3cret\n", "win32", (file) => { contentAtRestrict = readFileSync(file, "utf8"); return true; });
    assert.equal(contentAtRestrict, ""); assert.equal(readFileSync(f, "utf8"), "admin / s3cret\n"); rmSync(f);
    const err = console.error; const out: string[] = []; console.error = (m: string) => { out.push(m); };
    try { writeInitialPassword(f, "admin / s3cret\n", "win32", () => false); } finally { console.error = err; }
    assert.equal(existsSync(f), false); assert.equal(out.length, 1); assert.match(out[0], /s3cret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
