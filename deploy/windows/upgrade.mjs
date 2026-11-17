// Farm-Pilot CORE upgrade / rollback (Windows lab bundle). Layout: <base>\app (program), <base>\app.prev (previous program), <base>\data, <base>\backups, <base>\core.env.
// Run by upgrade.cmd from a temporary copy of node.exe, because the program folder is renamed. Data is never overwritten by an upgrade; the database is copied first (VACUUM INTO + integrity_check).
//   node upgrade.mjs <appDir> <zip>            install
//   node upgrade.mjs <appDir> /rollback [/keep-data]
// Every step that touches the program folder is a rename, so a failure leaves either the old or the new program in place, never half of each.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, copyFileSync } from "node:fs"; import { join, dirname, basename } from "node:path"; import { createRequire } from "node:module"; import { execFileSync } from "node:child_process"; import { fileURLToPath } from "node:url";

/** Rename a folder, retrying for a few seconds (antivirus / the search indexer sometimes hold a file for a moment). On failure the error says what usually holds the folder on Windows. */
export function renameRetry(from, to, tries = 10) {
  for (let i = 1; ; i++) {
    try { renameSync(from, to); return; }
    catch (e) { if (i >= tries) throw new Error(`could not rename ${from} (${e.code ?? e.message}). Close every window, Explorer folder, editor or PowerShell/cmd prompt that is inside ${dirname(from)} (cd to C:\\ first), then run the upgrade again. Nothing else was changed.`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}
const ts = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const buildOf = (app) => { try { return readFileSync(join(app, "dist", "BUILD"), "utf8").trim(); } catch { return "unknown"; } };
const versionOf = (app) => readJson(join(app, "package.json"))?.version ?? "?";

/** VACUUM INTO a new file, then integrity_check; throws on anything but "ok". `Database` is injectable (the real one comes from the INSTALLED program's node_modules). */
export function backupDb(Database, dbFile, outFile) {
  const live = new Database(dbFile, { readonly: true }); try { live.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`); } finally { live.close(); }
  const b = new Database(outFile, { readonly: true }); try { const r = b.pragma("integrity_check")[0].integrity_check; if (r !== "ok") throw new Error("backup integrity_check says: " + r); } finally { b.close(); }
}
/** `deps`: { Database, extract(zip, dir), checkNew(newApp) -> string[] (failed items), isRunning() -> bool, log }. */
export function upgrade({ base, zip, deps }) {
  const { log } = deps, app = join(base, "app"), prev = join(base, "app.prev"), tmp = join(base, "upgrade-tmp"), dataDir = join(base, "data"), dbFile = join(dataDir, "core.db");
  if (deps.isRunning()) throw new Error("CORE is running. Stop it first (Ctrl+C in its window), then run the upgrade again.");
  if (!zip || !existsSync(zip)) throw new Error("bundle zip not found: " + zip);
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true }); log(`unpacking ${basename(zip)} ...`); deps.extract(zip, tmp);
  const nu = join(tmp, "FarmPilot-Core", "app"); if (!existsSync(join(nu, "dist", "index.js")) || !existsSync(join(nu, "node", "node.exe"))) { rmSync(tmp, { recursive: true, force: true }); throw new Error("this zip is not a FarmPilot-Core lab bundle (FarmPilot-Core\\app\\dist\\index.js or node\\node.exe missing). Nothing was changed."); }
  const bad = deps.checkNew(nu); if (bad.length) { rmSync(tmp, { recursive: true, force: true }); throw new Error("the new program failed its own self-test: " + bad.join("; ") + ". Nothing was changed."); }
  let backup = null; if (existsSync(dbFile)) { backup = join(base, "backups", "pre-upgrade-" + ts()); mkdirSync(backup, { recursive: true }); (deps.backupDb ?? ((a, b) => backupDb(deps.Database, a, b)))(dbFile, join(backup, "core.db")); log("database copy checked (integrity ok): " + join(backup, "core.db")); }
  const from = { build: buildOf(app), version: versionOf(app) }, to = { build: buildOf(nu), version: versionOf(nu) };
  rmSync(prev, { recursive: true, force: true }); renameRetry(app, prev); try { renameSync(nu, app); } catch (e) { renameSync(prev, app); throw new Error("could not put the new program in place, the old one is back: " + e.message); }
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(join(base, "backups"), { recursive: true }); writeFileSync(join(base, "backups", "last-upgrade.json"), JSON.stringify({ at: new Date().toISOString(), from, to, db_backup: backup && join(backup, "core.db") }, null, 2));
  log(`upgraded ${from.version} (${from.build}) -> ${to.version} (${to.build}). Start it with start-core.cmd. To go back: upgrade.cmd /rollback`); return { from, to, backup };
}
export function rollback({ base, keepData = false, deps }) {
  const { log } = deps, app = join(base, "app"), prev = join(base, "app.prev"), failed = join(base, "app.rolled-back"), dataDir = join(base, "data"), info = readJson(join(base, "backups", "last-upgrade.json"));
  if (deps.isRunning()) throw new Error("CORE is running. Stop it first (Ctrl+C in its window), then roll back.");
  if (!existsSync(join(prev, "dist", "index.js"))) throw new Error("there is no previous program (app.prev) to go back to.");
  const dbBak = info?.db_backup && existsSync(info.db_backup) ? info.db_backup : null;
  if (!keepData && dbBak) { // keep what was entered since the upgrade, then put the pre-upgrade copy back
    const keep = join(base, "backups", "before-rollback-" + ts()); mkdirSync(keep, { recursive: true }); if (existsSync(join(dataDir, "core.db"))) (deps.backupDb ?? ((a, b) => backupDb(deps.Database, a, b)))(join(dataDir, "core.db"), join(keep, "core.db")); log("current database kept at " + join(keep, "core.db"));
    for (const x of ["core.db", "core.db-wal", "core.db-shm"]) rmSync(join(dataDir, x), { force: true }); copyFileSync(dbBak, join(dataDir, "core.db")); log("database restored from the copy taken before the upgrade (anything entered since is NOT in it)");
  } else log(keepData ? "database left as it is (/keep-data). The older program may not understand a newer database: if it will not start, roll back without /keep-data." : "no pre-upgrade database copy found: database left as it is.");
  rmSync(failed, { recursive: true, force: true }); renameRetry(app, failed); renameSync(prev, app);
  log(`rolled back to ${versionOf(app)} (${buildOf(app)}). The upgraded program is kept in ${failed}. Start it with start-core.cmd.`); return { restoredDb: !keepData && !!dbBak };
}
async function main() {
  const [appDir, ...args] = process.argv.slice(2), base = dirname(appDir), keepData = args.includes("/keep-data"), isRb = args.includes("/rollback"), zip = args.find((a) => a !== "/rollback" && a !== "/keep-data");
  const log = (m) => console.log(m);
  const port = Number(process.env.PORT || 4100);
  // 2026-11-17 -- the database copy runs in a CHILD process: loading better-sqlite3 here would keep app\\node_modules\\better-sqlite3\\...node locked, and Windows then refuses to rename the program folder.
  const backupScript = `const {createRequire}=require("node:module");const D=createRequire(process.argv[1])("better-sqlite3");const [,pkg,src,out]=process.argv;`
    + `const l=new D(src,{readonly:true});try{l.exec("VACUUM INTO '"+out.replace(/'/g,"''")+"'")}finally{l.close()}const b=new D(out,{readonly:true});try{const r=b.pragma("integrity_check")[0].integrity_check;if(r!=="ok")throw new Error("backup integrity_check says: "+r)}finally{b.close()}`;
  const deps = { log, backupDb: (src, out) => { try { execFileSync(process.execPath, ["-e", backupScript, join(appDir, "package.json"), src, out], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); } catch (e) { throw new Error("database copy failed, nothing was changed: " + String(e.stderr ?? e.message).trim().split("\n").slice(-1)[0]); } },
    isRunning: () => { try { execFileSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/api/health",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], { stdio: "ignore" }); return true; } catch { return false; } },
    extract: (z, dir) => { execFileSync("tar", ["-xf", z, "-C", dir], { stdio: "inherit", windowsHide: true }); },
    checkNew: (nu) => { try { const o = execFileSync(join(nu, "node", "node.exe"), [join(nu, "check.mjs")], { encoding: "utf8", cwd: nu, windowsHide: true, env: { ...process.env, PORT: "0" } }); void o; return []; } catch (e) { return String(e.stdout ?? "").split("\n").filter((l) => /^FAIL/.test(l)).map((l) => l.slice(6)).concat(String(e.stdout ?? "").includes("FAIL") ? [] : [String(e.message)]); } } };
  try { if (isRb) rollback({ base, keepData, deps }); else upgrade({ base, zip, deps }); } catch (e) { console.error("\nUPGRADE STOPPED: " + (e?.message ?? e)); process.exit(1); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
