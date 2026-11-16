// Serial ports found on the box. Stable by-id names first (USB-RS485 adapters get unstable ttyUSBn numbers after a reboot), then ttyUSB*, ttyACM*, ttyS*.
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";

export interface FoundSerial { path: string; kind: "by-id" | "usb" | "acm" | "tty"; target: string; accessible: boolean; }
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

/** Plain-English text for the common open/connect failures, with the Linux group hint. */
export function errorText(e: unknown, p?: { transport: string; device_path: string; tcp_host: string; tcp_port: number }): string {
  const m = String((e as Error)?.message ?? e), code = (e as any)?.code as string | undefined;
  if (/EACCES|permission denied/i.test(m) || code === "EACCES") return `Permission denied opening ${p?.device_path ?? "the serial port"}: the CORE service account must be in the "dialout" group (sudo usermod -aG dialout fpcore, then restart CORE).`;
  if (/ENOENT|no such file/i.test(m) || code === "ENOENT") return `Device ${p?.device_path ?? ""} not found: unplugged, or the name changed. Pick the device again.`;
  if (/EBUSY|resource busy/i.test(m)) return `Device ${p?.device_path ?? ""} is busy: another program has it open.`;
  if (/ECONNREFUSED/.test(m + code)) return `Connection refused by ${p?.tcp_host}:${p?.tcp_port}.`;
  if (/connect timeout/i.test(m)) return `No connection to ${p?.tcp_host}:${p?.tcp_port} (timeout).`;
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(m + code)) return `Cannot reach ${p?.tcp_host}.`;
  return m;
}
