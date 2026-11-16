// Serial ports found on the box. Stable by-id names first (USB-RS485 adapters get unstable ttyUSBn numbers after a reboot), then ttyUSB*, ttyACM*, ttyS*.
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { isWin, type Platform } from "../platform.js";
import { canonicalSerialPath } from "./serialPath.js";

export interface FoundSerial { path: string; kind: "by-id" | "usb" | "acm" | "tty" | "com"; target: string; accessible: boolean; /** Windows: friendly name from the driver, e.g. "USB Serial Port (COM4)". */ label?: string; }
const canOpen = (p: string) => { try { accessSync(p, constants.R_OK | constants.W_OK); return true; } catch { return false; } };

export function listSerial(dev = "/dev"): FoundSerial[] {
  const out: FoundSerial[] = []; const seenTargets = new Set<string>();
  const add = (path: string, kind: FoundSerial["kind"]) => { let target = path; try { target = realpathSync(path); } catch { /* dangling link */ } out.push({ path, kind, target, accessible: canOpen(path) }); seenTargets.add(target); };
  const byId = dev + "/serial/by-id";
  if (existsSync(byId)) for (const n of readdirSync(byId).sort()) add(`${byId}/${n}`, "by-id");
  let names: string[] = []; try { names = readdirSync(dev); } catch { /* no /dev */ }
  for (const [re, kind] of [[/^ttyUSB\d+$/, "usb"], [/^ttyACM\d+$/, "acm"], [/^ttyS\d+$/, "tty"]] as const)
    for (const n of names.filter((x) => re.test(x)).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))) { const p = `${dev}/${n}`; let real = p; try { real = realpathSync(p); } catch { /* ignore */ }
      if (kind === "tty" && !canOpen(p)) continue;                    // the many unwired ttyS* of a PC that the service cannot open are noise
      if (!seenTargets.has(real)) add(p, kind); }
  return out;
}

// ---------- Windows (W1): serial ports come from SerialPort.list(), there is no /dev to scan ----------
export interface WinPortInfo { path: string; friendlyName?: string; manufacturer?: string; }
type WinLister = () => Promise<WinPortInfo[]>;
const defaultWinLister: WinLister = async () => { const { SerialPort } = await import("serialport"); return (await SerialPort.list()) as WinPortInfo[]; };
let winCache: { at: number; ports: Set<string> } | null = null;

/** COM ports present now, sorted by number. Also refreshes the presence cache used by serialPresent(). A missing serialport module gives an empty list. */
export async function listSerialWin(list: WinLister = defaultWinLister): Promise<FoundSerial[]> {
  let infos: WinPortInfo[] = []; try { infos = await list(); } catch { /* serialport not installed or driver error: empty list */ }
  const found: FoundSerial[] = []; const seen = new Set<string>();
  for (const i of infos) { const path = canonicalSerialPath(i.path, "win32"); if (!path || seen.has(path)) continue; seen.add(path);
    const friendly = i.friendlyName || i.manufacturer || ""; found.push({ path, kind: "com", target: path, accessible: true, label: friendly && !friendly.includes(path) ? `${path} - ${friendly}` : friendly || path }); }
  found.sort((a, b) => Number(a.path.slice(3)) - Number(b.path.slice(3)));
  winCache = { at: Date.now(), ports: seen }; return found;
}
/** Refresh the Windows presence cache if it is older than maxAgeMs. Called before the ports view is built; a no-op on Linux. */
export async function refreshSerialCache(maxAgeMs = 3000, list?: WinLister, platform: Platform = process.platform) {
  if (!isWin(platform) || (winCache && Date.now() - winCache.at < maxAgeMs)) return; await listSerialWin(list);
}
/**
 * Is the configured serial device there? Linux: existsSync, exactly as before. Windows: is the COM name in the last SerialPort.list() result.
 * Before the first list the answer is "yes" (unknown is not reported as NOT FOUND; a real open error shows as ERROR instead).
 */
export function serialPresent(path: string, platform: Platform = process.platform): boolean {
  if (!isWin(platform)) return existsSync(path);
  const c = canonicalSerialPath(path, platform); if (!c) return false; return winCache ? winCache.ports.has(c) : true;
}
export const resetSerialCacheForTests = () => { winCache = null; };

/** Plain-English text for the common open/connect failures. On Linux it carries the "dialout" group hint; on Windows (W1) the Windows wording and no group hint. */
export function errorText(e: unknown, p?: { transport: string; device_path: string; tcp_host: string; tcp_port: number }, platform: Platform = process.platform): string {
  const m = String((e as Error)?.message ?? e), code = (e as any)?.code as string | undefined;
  if (isWin(platform) && p?.transport !== "tcp") {
    const name = p?.device_path || "the serial port";
    if (/access (is )?denied|EACCES|EPERM/i.test(m) || code === "EACCES") return `Cannot open ${name}: another program has it open (a serial monitor, a vendor tool or a second CORE), or Windows denied access. Close the other program and try again.`;
    if (/file not found|cannot find|ENOENT|no such file|system cannot find/i.test(m) || code === "ENOENT") return `${name} not found: the adapter is unplugged, or Windows gave it a different COM number. Check Device Manager and pick the port again.`;
    if (/EBUSY|resource busy|in use/i.test(m)) return `${name} is in use by another program. Close it and try again.`;
  }
  if (/EACCES|permission denied/i.test(m) || code === "EACCES") return `Permission denied opening ${p?.device_path ?? "the serial port"}: the CORE service account must be in the "dialout" group (sudo usermod -aG dialout fpcore, then restart CORE).`;
  if (/ENOENT|no such file/i.test(m) || code === "ENOENT") return `Device ${p?.device_path ?? ""} not found: unplugged, or the name changed. Pick the device again.`;
  if (/EBUSY|resource busy/i.test(m)) return `Device ${p?.device_path ?? ""} is busy: another program has it open.`;
  if (/ECONNREFUSED/.test(m + code)) return `Connection refused by ${p?.tcp_host}:${p?.tcp_port}.`;
  if (/connect timeout/i.test(m)) return `No connection to ${p?.tcp_host}:${p?.tcp_port} (timeout).`;
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(m + code)) return `Cannot reach ${p?.tcp_host}.`;
  return m;
}
