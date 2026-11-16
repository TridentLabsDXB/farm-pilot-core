// Device ID: FP-XXXX-XXXX-XXXX = first 12 hex characters of SHA-256("farmpilot-core|" + machine id), upper case, grouped by 4.
// Machine id: Linux /etc/machine-id (fallback /var/lib/dbus/machine-id); Windows registry HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid.
// The machine id is trimmed and lower-cased first, so the ID does not depend on how a tool prints it. Known risk (spec): a cloned VM or disk image copies the ID; a replaced board changes it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const DEVICE_ID_RE = /^FP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
export function deviceIdFromMachineId(machineId: string): string {
  const h = createHash("sha256").update("farmpilot-core|" + machineId.trim().toLowerCase()).digest("hex").slice(0, 12).toUpperCase();
  return `FP-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

export interface MachineIdDeps { readFile?: (p: string) => string; run?: (file: string, args: string[]) => string; }
/** The raw machine id, or null when this host has none (a bare container). Never throws. Deps are injectable so the Windows branch is tested on Linux; the real registry call needs a Windows machine to verify. */
export function readMachineId(platform: NodeJS.Platform = process.platform, deps: MachineIdDeps = {}): string | null {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8")), run = deps.run ?? ((f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  const ok = (s: string) => { const t = s.trim(); return /^[0-9A-Fa-f-]{16,}$/.test(t) ? t : null; };
  if (platform === "win32") {
    try { const m = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{16,})/i.exec(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])); return m ? m[1] : null; } catch { return null; }
  }
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) { try { const v = ok(readFile(p)); if (v) return v; } catch { /* next */ } }
  return null;
}
/** This box's Device ID, or null when no machine id can be read. */
export const thisDeviceId = (platform: NodeJS.Platform = process.platform, deps: MachineIdDeps = {}): string | null => { const m = readMachineId(platform, deps); return m ? deviceIdFromMachineId(m) : null; };
