// Farm-Pilot CORE on Windows: self-test of the native pieces, run it BEFORE the first start (check.cmd runs this with the bundled node.exe).
// Prints PASS / FAIL per step and exits 1 if anything essential failed. Changes nothing except a tiny temp file in the data folder to prove it is writable.
import { createRequire } from "node:module"; import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url"; import os from "node:os";
const require = createRequire(import.meta.url); const here = dirname(fileURLToPath(import.meta.url)); let bad = 0;
const ok = (m) => console.log("PASS  " + m), fail = (m) => { bad++; console.log("FAIL  " + m); }, info = (m) => console.log("      " + m);

console.log("Farm-Pilot CORE self-test\n");
const major = Number(process.versions.node.split(".")[0]);
(major >= 22 ? ok : fail)(`Node ${process.version} (${process.platform} ${process.arch}), need 22 or newer, win32 x64`);
if (process.platform !== "win32" || process.arch !== "x64") info("note: this is not Windows x64, so this run does not prove the Windows binaries.");
try { const b = readBuild(); ok("CORE build " + b); } catch { fail("dist\\BUILD not found: is this the CORE program folder?"); }
function readBuild() { return require("node:fs").readFileSync(join(here, "dist", "BUILD"), "utf8").trim(); }

try { const Database = require("better-sqlite3"); const db = new Database(":memory:"); const v = db.prepare("select sqlite_version() v").get().v;
  db.exec("create table t(a); insert into t values (1)"); const n = db.prepare("select count(*) n from t").get().n; db.close(); (n === 1 ? ok : fail)(`better-sqlite3 loads, SQLite ${v}, query works`); }
catch (e) { fail("better-sqlite3 did not load: " + (e?.message ?? e)); }

let SerialPort;
try { ({ SerialPort } = await import("serialport")); ok("serialport loads"); } catch (e) { fail("serialport did not load: " + (e?.message ?? e)); }
if (SerialPort) {
  try { const l = await SerialPort.list(); if (!l.length) info("no COM ports found (plug in the USB-RS485 adapter and run again if you expected one)");
    else { ok(`${l.length} COM port(s) found`); for (const p of l) info(`${p.path}   ${p.friendlyName ?? p.manufacturer ?? ""}   ${[p.vendorId && "VID " + p.vendorId, p.productId && "PID " + p.productId, p.serialNumber && "SN " + p.serialNumber].filter(Boolean).join(" ")}`); } }
  catch (e) { fail("listing COM ports failed: " + (e?.message ?? e)); }
}

try { const { defaultPaths } = await import(pathToFileURL(join(here, "dist", "platform.js")).href); const p = defaultPaths(); info(`data folder: ${p.dataDir}`); info(`settings:    ${p.envFile}${existsSync(p.envFile) ? "" : "  (not present, optional)"}`);
  mkdirSync(p.dataDir, { recursive: true }); const t = join(p.dataDir, ".check-write-test"); writeFileSync(t, "x"); rmSync(t); ok("data folder is writable"); }
catch (e) { fail("data folder: " + (e?.message ?? e)); }
info(`host: ${os.hostname()}, ${os.type()} ${os.release()}, ${Math.round(os.totalmem() / 1048576)} MB RAM`);
console.log("\n" + (bad ? `${bad} check(s) FAILED: do not start CORE, send this output.` : "All checks passed. You can run start-core.cmd."));
process.exit(bad ? 1 : 0);
