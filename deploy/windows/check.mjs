// Farm-Pilot CORE on Windows: self-test, run it BEFORE the first start (check.cmd runs this with the bundled node.exe). Lab bundle 2026-11-17.
// Prints PASS / FAIL per item and ends with "All checks passed." or the list of failed items (exit code 1). Changes nothing except two tiny temp files in the data folder
// (a write test and a SQLite test database) that it deletes again. Every check is a small exported function, so test/lab-bundle.test.ts runs the logic on Linux too.
import { createRequire } from "node:module"; import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"; import { join, dirname, win32 } from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process"; import net from "node:net"; import os from "node:os";
const require = createRequire(import.meta.url); const here = dirname(fileURLToPath(import.meta.url));

/** KEY=VALUE per line, # comments, optional quotes. Same shape node --env-file reads. */
export function parseEnvFile(text) { const o = {}; for (const raw of String(text).split(/\r?\n/)) { const l = raw.trim(); if (!l || l.startsWith("#")) continue; const i = l.indexOf("="); if (i < 1) continue; let v = l.slice(i + 1).trim(); if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1); o[l.slice(0, i).trim()] = v; } return o; }

/** Drive kind from the PowerShell line "type=<Win32_LogicalDisk.DriveType>;bus=<disk BusType>". Removable (2), network (4), CD (5) and USB-bus disks are refused for the database. */
export function classifyDrive(line) {
  const t = /type=(\d+)/.exec(line ?? ""), b = /bus=([A-Za-z0-9 ]*)/.exec(line ?? ""), type = t ? Number(t[1]) : null, bus = (b?.[1] ?? "").trim();
  if (type === 2) return { ok: false, text: "removable drive (USB stick / SD card)" }; if (type === 4) return { ok: false, text: "network drive" }; if (type === 5) return { ok: false, text: "CD/DVD drive" };
  if (/^usb$/i.test(bus)) return { ok: false, text: "USB-connected disk" }; if (type === 3) return { ok: true, text: `fixed local disk${bus ? " (" + bus + ")" : ""}` };
  return { ok: null, text: "drive type could not be determined" };
}
/** Windows only. UNC paths are refused outright; otherwise one PowerShell query for the drive letter. `run` is injectable. */
export function dataDriveKind(dataDir, platform = process.platform, run = (f, a) => execFileSync(f, a, { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] })) {
  if (platform !== "win32") return { ok: true, text: "not Windows: drive type not checked" };
  if (/^\\\\/.test(dataDir)) return { ok: false, text: "network path (UNC)" };
  const m = /^([A-Za-z]):/.exec(dataDir); if (!m) return { ok: null, text: "no drive letter in the data path" };
  const L = m[1].toUpperCase(), ps = `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${L}:'"; $b=''; try{ $b=(Get-Partition -DriveLetter ${L} -ErrorAction Stop | Get-Disk -ErrorAction Stop).BusType }catch{}; "type=$($d.DriveType);bus=$b"`;
  try { return classifyDrive(run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps])); } catch { return { ok: null, text: "drive type could not be determined (PowerShell unavailable)" }; }
}
/** Tries to listen on the port on all interfaces, then releases it. */
export function portFree(port, host = "0.0.0.0") { return new Promise((res) => { const s = net.createServer(); s.once("error", (e) => res({ ok: false, code: e.code })); s.listen(port, host, () => s.close(() => res({ ok: true }))); }); }

export async function runChecks({ appDir = here, env = process.env, platform = process.platform, arch = process.arch, run, drive = dataDriveKind } = {}) {
  const out = [], add = (name, ok, text, notes = []) => out.push({ name, ok: ok === true, warn: ok === null, text, notes });
  const major = Number(process.versions.node.split(".")[0]);
  add("Node version", major >= 22 && platform === "win32" && arch === "x64", `Node ${process.version} (${platform} ${arch}); need 22 or newer on win32 x64`, platform === "win32" && arch === "x64" ? [] : ["this is not Windows x64, so this run does not prove the Windows binaries"]);
  let build = ""; try { build = readFileSync(join(appDir, "dist", "BUILD"), "utf8").trim(); add("CORE program files", true, `build ${build}`); } catch { add("CORE program files", false, "dist\\BUILD not found: is this the CORE program folder?"); }

  // native modules
  let SerialPort, sqliteOk = false, Database;
  try { Database = require("better-sqlite3"); const db = new Database(":memory:"); const v = db.prepare("select sqlite_version() v").get().v; db.exec("create table t(a); insert into t values (1)"); sqliteOk = db.prepare("select count(*) n from t").get().n === 1; db.close(); add("Native module better-sqlite3", sqliteOk, `loads, SQLite ${v}, query works`); }
  catch (e) { add("Native module better-sqlite3", false, "did not load: " + (e?.message ?? e), ["send this text: the Windows binaries are checked at build time, a failure here is new information"]); }
  try { ({ SerialPort } = await import("serialport")); add("Native module serialport", true, "loads"); } catch (e) { add("Native module serialport", false, "did not load: " + (e?.message ?? e)); }

  // paths: same rules as the program (dist/platform.js), plus core.env next to the data
  let paths = { dataDir: join(os.homedir(), "FarmPilot-Core", "data"), envFile: "", logsDir: "" }, fileEnv = {};
  try { const { defaultPaths } = await import(pathToFileURL(join(appDir, "dist", "platform.js")).href); paths = defaultPaths(platform, env); if (existsSync(paths.envFile)) fileEnv = parseEnvFile(readFileSync(paths.envFile, "utf8")); if (fileEnv.DATA_DIR || fileEnv.FARMPILOT_CORE_HOME) paths = defaultPaths(platform, { ...fileEnv, ...env }); } catch (e) { add("Data folder location", false, "could not work out the data folder: " + (e?.message ?? e)); }
  let writable = false; try { mkdirSync(paths.dataDir, { recursive: true }); const t = join(paths.dataDir, ".check-write-test"); writeFileSync(t, "x"); rmSync(t); writable = true; add("Data folder writable", true, paths.dataDir, [paths.envFile && `settings file: ${paths.envFile}${existsSync(paths.envFile) ? "" : " (not present, optional)"}`].filter(Boolean)); } catch (e) { add("Data folder writable", false, `${paths.dataDir}: ${e?.message ?? e}`); }

  // SQLite write test ON the data volume; a removable / USB / network drive is refused
  const dk = drive(paths.dataDir, platform, run); add("Data drive is internal", dk.ok === false ? false : dk.ok === null ? null : true, dk.text);
  if (Database && writable) { const f = join(paths.dataDir, ".check-sqlite-test.db"); try { const db = new Database(f); db.pragma("journal_mode = WAL"); db.exec("create table t(a); insert into t values (1),(2),(3)"); const n = db.prepare("select count(*) n from t").get().n; db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); add("SQLite write test on the data volume", n === 3, n === 3 ? "WAL database created, written and read back" : "wrote 3 rows but read " + n); } catch (e) { add("SQLite write test on the data volume", false, e?.message ?? e); } finally { for (const x of ["", "-wal", "-shm"]) rmSync(f + x, { force: true }); } }
  else add("SQLite write test on the data volume", false, "skipped: " + (!Database ? "better-sqlite3 did not load" : "data folder not writable"));

  // serial ports
  if (SerialPort) { try { const l = await SerialPort.list(); if (!l.length) add("Serial ports", true, "no COM ports found (plug in the USB-RS485 adapter and run check.cmd again if you expected one)"); else add("Serial ports", true, `${l.length} COM port(s) found`, l.map((p) => `${p.path}   ${p.friendlyName ?? p.manufacturer ?? ""}   ${[p.vendorId && "VID " + p.vendorId, p.productId && "PID " + p.productId, p.serialNumber && "SN " + p.serialNumber].filter(Boolean).join(" ")}`.trimEnd())); } catch (e) { add("Serial ports", false, "listing COM ports failed: " + (e?.message ?? e)); } }
  else add("Serial ports", false, "skipped: serialport did not load");

  // licence: verifies the installed file (if any) with the same code and keys as the program; reads only
  try {
    const file = join(paths.dataDir, "licence", "current.fplic");
    if (!existsSync(file)) add("Licence", true, "FREE (no licence file installed)");
    else { const { checkLicence, expiryMs } = await import(pathToFileURL(join(appDir, "dist", "licence", "format.js")).href), { LICENCE_PUBLIC_KEYS } = await import(pathToFileURL(join(appDir, "dist", "licence", "keys.js")).href), { thisDeviceId } = await import(pathToFileURL(join(appDir, "dist", "licence", "device.js")).href);
      try { const f = checkLicence(readFileSync(file), LICENCE_PUBLIC_KEYS, thisDeviceId()); const exp = expiryMs(f); add("Licence", exp > Date.now(), exp > Date.now() ? `${f.type} licence for "${f.licensed_to}" is valid${f.valid_until ? " until " + f.valid_until.slice(0, 10) : ", no expiry"}` : `${f.type} licence expired on ${f.valid_until?.slice(0, 10)} (FREE limits apply)`); }
      catch (e) { add("Licence", false, "licence file present but INVALID: " + (e?.message ?? e), ["the box would run with FREE limits and keep all data"]); } }
  } catch (e) { add("Licence", false, "could not check the licence: " + (e?.message ?? e)); }

  // time zone and clock (a tablet with a flat clock battery shows 2015 or similar)
  { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone, off = -new Date().getTimezoneOffset() / 60, yr = new Date().getFullYear(); const okTz = !!tz && yr >= 2026;
    add("Time zone and clock", okTz, `${tz || "unknown zone"} (UTC${off >= 0 ? "+" : ""}${off}), now ${new Date().toString().slice(0, 24)}`, yr >= 2026 ? (tz === "UTC" || tz === "Etc/UTC" ? ["zone is UTC: set the tablet's time zone in Windows (Settings > Time & language) so alarms and reports show local time"] : []) : ["the clock looks wrong (year " + yr + "): set date and time in Windows before the lab"]); }

  // listening port
  { const port = Number(env.PORT || fileEnv.PORT || 4100), r = await portFree(port); add(`Port ${port} is free`, r.ok, r.ok ? "nothing is listening on it" : r.code === "EADDRINUSE" ? "already in use: is CORE already running, or another program on this port? (set PORT in core.env to change)" : `cannot listen (${r.code})`); }

  const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
  return { results: out, host: `${os.hostname()}, ${os.type()} ${os.release()}, ${Math.round(os.totalmem() / 1048576)} MB RAM, LAN ${lan.join(", ") || "none"}` };
}
export function render({ results, host }) {
  const lines = ["Farm-Pilot CORE self-test", ""]; for (const r of results) { lines.push(`${r.ok ? "PASS" : r.warn ? "WARN" : "FAIL"}  ${r.name}: ${r.text}`); for (const n of r.notes) lines.push("        " + n); }
  const failed = results.filter((r) => !r.ok && !r.warn); lines.push("", `host: ${host}`, "");
  lines.push(failed.length ? `${failed.length} check(s) FAILED: ${failed.map((r) => r.name).join("; ")}. Do not start CORE; send this output.` : "All checks passed. You can run start-core.cmd."); return { text: lines.join("\n"), failed: failed.length };
}
if (process.argv[1] && dirname(fileURLToPath(pathToFileURL(process.argv[1]).href)) === here) { const r = render(await runChecks()); console.log(r.text); process.exit(r.failed ? 1 : 0); }
