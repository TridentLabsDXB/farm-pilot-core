// Windows port (phase W1). Everything platform-specific that is not a serial port lives here, as small pure functions that take the platform as an
// argument (default process.platform), so the Windows branch is unit-tested on Linux too. On Linux every function returns exactly what the old
// inline code did: nothing in this file changes Linux behaviour.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { win32 } from "node:path";

export type Platform = NodeJS.Platform;
export const isWin = (p: Platform = process.platform) => p === "win32";

/** Windows base folder. Deliberately NOT C:\FarmPilot, which belongs to the main Farm-Pilot app. */
export const WIN_BASE = "C:\\FarmPilot-Core";

export interface DefaultPaths { dataDir: string; dbPath: string; logsDir: string; envFile: string; serialPath: string; }
/**
 * Default locations. Linux keeps the systemd layout. On Windows everything hangs off C:\FarmPilot-Core (override the whole base with
 * FARMPILOT_CORE_HOME, or only the data with DATA_DIR / DB_PATH). DB_PATH defaults to <DATA_DIR>\core.db on Windows, so moving the data
 * directory moves the database with it. On Linux DB_PATH and DATA_DIR stay independent, as before.
 */
export function defaultPaths(platform: Platform = process.platform, env: Record<string, string | undefined> = process.env): DefaultPaths {
  if (!isWin(platform)) return { dataDir: env.DATA_DIR || "/var/lib/farmpilot-core", dbPath: env.DB_PATH || "/var/lib/farmpilot-core/core.db", logsDir: env.LOGS_DIR || "/var/log/farmpilot-core", envFile: "/etc/farmpilot-core.env", serialPath: "/dev/ttyUSB0" };
  const base = env.FARMPILOT_CORE_HOME || WIN_BASE, dataDir = env.DATA_DIR || win32.join(base, "data");
  return { dataDir, dbPath: env.DB_PATH || win32.join(dataDir, "core.db"), logsDir: env.LOGS_DIR || win32.join(base, "logs"), envFile: win32.join(base, "core.env"), serialPath: "COM3" };
}

/** Signals that must trigger the clean shutdown (WAL checkpoint + db.close). Windows never delivers SIGTERM; Ctrl+C is SIGINT, Ctrl+Break and console close are SIGBREAK / SIGHUP. */
export const shutdownSignals = (platform: Platform = process.platform): NodeJS.Signals[] => (isWin(platform) ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGTERM", "SIGINT"]);

type Run = (file: string, args: string[]) => unknown;
/**
 * Windows equivalent of chmod 600: drop inherited permissions and grant Full control to the current account only (icacls). Returns true when the
 * file is restricted. On Linux this is a no-op that returns true (the caller already wrote the file with mode 0o600).
 * The account is identified by SID (`whoami /user`), because under Task Scheduler / a service as SYSTEM the DOMAIN\USER environment values are
 * not an account icacls can resolve; the name form is only the fallback. `run` and `user` are injectable for tests; the real icacls and whoami
 * calls need a Windows machine to verify.
 */
export function restrictToCurrentUser(file: string, platform: Platform = process.platform, run: Run = (f, a) => execFileSync(f, a, { stdio: "pipe", windowsHide: true }), user?: string): boolean {
  if (!isWin(platform)) return true;
  try { run("icacls", [file, "/inheritance:r", "/grant:r", `${user ?? currentWindowsGrantee()}:(F)`]); return true; } catch { return false; }
}
function currentWindowsGrantee(): string {
  try { const sid = /(S-1-[0-9-]+)/.exec(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }))?.[1]; if (sid) return "*" + sid; } catch { /* fall through */ }
  const u = userInfo().username, d = process.env.USERDOMAIN; return d && !u.includes("\\") ? `${d}\\${u}` : u;
}
