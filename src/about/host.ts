// THIS COMPUTER card (Admin) and the host part of diagnostics. Every source is injectable, so the Windows branch runs in tests on Linux.
// Windows facts that only a real Windows machine can confirm: reg.exe output, SerialPort.list(), fs.statfs on a drive letter, os.version() wording (see the report).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as nodeOs from "node:os";
import { statfs } from "node:fs/promises";
import type { Db } from "../db.js";

export interface Computer {
  computer_name: string; operating_system: string; cpu: string; memory_used_bytes: number; memory_total_bytes: number; disk_free_bytes: number | null; disk_total_bytes: number | null;
  uptime_s: number; ip_addresses: string[]; time_zone: string; node_version: string; sqlite_version: string; database_bytes: number | null; serial_ports: string[]; data_folder: string; platform: string;
}
export interface HostDeps {
  platform?: NodeJS.Platform; os?: Pick<typeof nodeOs, "hostname" | "version" | "release" | "cpus" | "totalmem" | "freemem" | "uptime" | "networkInterfaces">;
  run?: (file: string, args: string[]) => string; readFile?: (p: string) => string; statfs?: (p: string) => Promise<{ bsize: number; bavail: number; blocks: number }>;
  fileSize?: (p: string) => number | null; serialPorts?: () => Promise<string[]>; nodeVersion?: string;
}
const defRun = (f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
const regValue = (out: string, name: string) => new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i").exec(out)?.[1]?.trim();

/** "Ubuntu 24.04 LTS (Linux 6.8.0)" on Linux; "Windows 11 Pro 23H2 (build 22631)" on Windows. */
export function osName(d: HostDeps = {}): string {
  const platform = d.platform ?? process.platform, o = d.os ?? nodeOs, run = d.run ?? defRun, read = d.readFile ?? ((p) => readFileSync(p, "utf8"));
  if (platform === "win32") {
    let name = (() => { try { return o.version(); } catch { return ""; } })(), ver = "", build = o.release().split(".").pop() ?? "";
    try { const out = run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"]); ver = regValue(out, "DisplayVersion") ?? ""; build = regValue(out, "CurrentBuildNumber") ?? build; if (!/windows/i.test(name)) name = regValue(out, "ProductName") ?? name; } catch { /* keep os.version() */ }
    const b = Number(build); if (b >= 22000 && /windows 10/i.test(name)) name = name.replace(/windows 10/i, "Windows 11");           // the registry still says "Windows 10" on Windows 11
    return `${name || "Windows"}${ver ? " " + ver : ""} (build ${build})`;
  }
  let pretty = ""; try { pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(read("/etc/os-release"))?.[1] ?? ""; } catch { /* no os-release */ }
  return `${pretty || o.version()} (${platform === "linux" ? "Linux" : platform} ${o.release()})`;
}

export async function computerInfo(db: Db, opts: { dataDir: string; dbPath: string; timezone?: string }, d: HostDeps = {}): Promise<Computer> {
  const platform = d.platform ?? process.platform, o = d.os ?? nodeOs;
  const size = d.fileSize ?? ((p: string) => { try { return statSync(p).size; } catch { return null; } });
  let free: number | null = null, total: number | null = null;
  try { const s = await (d.statfs ?? ((p: string) => statfs(p)))(opts.dataDir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch { /* folder missing: shown as -- */ }
  const ips: string[] = []; for (const list of Object.values(o.networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  const cpus = o.cpus(); const db1 = size(opts.dbPath), wal = size(opts.dbPath + "-wal");
  let sqlite = ""; try { sqlite = String((db.prepare("select sqlite_version() v").get() as { v: string }).v); } catch { /* closed db */ }
  let ports: string[] = []; try { ports = await (d.serialPorts ?? (() => Promise.resolve([])))(); } catch { /* listing failed */ }
  let tz = opts.timezone ?? ""; if (!tz) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = "UTC"; } }
  return { computer_name: o.hostname(), operating_system: osName(d), cpu: cpus.length ? `${cpus[0].model.replace(/\s+/g, " ").trim()} x${cpus.length}` : "--", memory_used_bytes: o.totalmem() - o.freemem(), memory_total_bytes: o.totalmem(),
    disk_free_bytes: free, disk_total_bytes: total, uptime_s: Math.round(o.uptime()), ip_addresses: ips, time_zone: tz, node_version: d.nodeVersion ?? process.version, sqlite_version: sqlite,
    database_bytes: db1 === null ? null : db1 + (wal ?? 0), serial_ports: ports, data_folder: opts.dataDir, platform };
}

/** Serial ports as plain names. Windows: SerialPort.list() (COM3...). Linux: the existing /dev listing. A missing serialport module or a driver error gives an empty list. */
export async function listSerialNames(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "win32") { try { const { SerialPort } = await import("serialport"); return ((await SerialPort.list()) as { path: string }[]).map((p) => p.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { return []; } }
  try { const { listSerial } = await import("../ports/available.js"); return listSerial().map((p) => p.path); } catch { return []; }
}
