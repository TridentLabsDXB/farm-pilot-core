// THIS COMPUTER card (Admin) and the host part of diagnostics. Every source is injectable, so the Windows branch runs in tests on Linux.
// Windows facts that only a real Windows machine can confirm: reg.exe output, SerialPort.list(), fs.statfs on a drive letter, os.version() wording (see the report).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as nodeOs from "node:os";
import { statfs } from "node:fs/promises";
import type { Db } from "../db.js";

/** Every field is null when its source failed ("unavailable" in the UI): one failing call never takes the whole answer down. */
export interface Computer {
  computer_name: string | null; operating_system: string | null; cpu: string | null; memory_used_bytes: number | null; memory_total_bytes: number | null; disk_free_bytes: number | null; disk_total_bytes: number | null;
  uptime_s: number | null; ip_addresses: string[] | null; time_zone: string | null; node_version: string | null; sqlite_version: string | null; database_bytes: number | null; serial_ports: string[] | null; data_folder: string | null; platform: string | null;
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

/** Virtual, bridge and loopback interfaces that are noise on the About page: lo, docker0, br-*, veth*, virbr*, VM and container adapters, Windows vEthernet / VMware / VirtualBox / Hyper-V / loopback. */
export const VIRTUAL_IFACE = /^(lo\d*|docker.*|br-.*|veth.*|virbr.*|vmnet.*|vboxnet.*|cni.*|flannel.*|cali.*|kube.*|vEthernet.*|.*VMware.*|.*VirtualBox.*|.*Hyper-V.*|Loopback.*)$/i;
const linkLocal = (a: string) => a.startsWith("169.254.");
/**
 * Real (non-virtual, non-link-local, non-loopback) IPv4 addresses. os.networkInterfaces() throws EAFNOSUPPORT (error 97) under the systemd unit's address-family restrictions (found on the bench, 2026-11-16),
 * so Linux then reads the local addresses from /proc/net/fib_trie and maps each to its interface through /proc/net/route to apply the same name filter. Never throws.
 */
export function ipv4Addresses(o: Pick<typeof nodeOs, "networkInterfaces">, read: (p: string) => string): string[] {
  try { const ips: string[] = []; for (const [name, list] of Object.entries(o.networkInterfaces())) if (!VIRTUAL_IFACE.test(name)) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !linkLocal(a.address)) ips.push(a.address); return ips; } catch { /* fall through */ }
  try {
    const out = new Set<string>(); const lines = read("/proc/net/fib_trie").split("\n");
    for (let i = 0; i < lines.length - 1; i++) { const m = /\|-- (\d+\.\d+\.\d+\.\d+)\s*$/.exec(lines[i]); if (m && /\/32 host LOCAL/.test(lines[i + 1]) && !m[1].startsWith("127.") && !linkLocal(m[1])) out.add(m[1]); }
    const routes: { iface: string; dest: number; mask: number }[] = []; try { for (const l of read("/proc/net/route").split("\n").slice(1)) { const f = l.trim().split(/\s+/); if (f.length > 7 && f[0]) { const le = (h: string) => parseInt(h, 16) >>> 0; /* the kernel prints the native little-endian 32-bit value as hex */ const mask = le(f[7]); if (mask) routes.push({ iface: f[0], dest: le(f[1]), mask }); } } } catch { /* no route table: keep all */ }
    const bytes = (a: string) => Buffer.from(a.split(".").map(Number)).readUInt32LE(0);
    return [...out].filter((a) => { const hit = routes.find((r) => ((bytes(a) & r.mask) >>> 0) === r.dest); return !(hit && VIRTUAL_IFACE.test(hit.iface)); });
  } catch { return []; }
}
const safe = <T>(f: () => T): T | null => { try { const v = f(); return v === undefined ? null : v; } catch { return null; } };
const safeAsync = async <T>(f: () => Promise<T>): Promise<T | null> => { try { const v = await f(); return v === undefined ? null : v; } catch { return null; } };

export async function computerInfo(db: Db, opts: { dataDir: string; dbPath: string; timezone?: string }, d: HostDeps = {}): Promise<Computer> {
  const platform = d.platform ?? process.platform, o = d.os ?? nodeOs, read = d.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const size = d.fileSize ?? ((p: string) => { try { return statSync(p).size; } catch { return null; } });
  const disk = await safeAsync(async () => { const s = await (d.statfs ?? ((p: string) => statfs(p)))(opts.dataDir); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; });
  const dbSize = safe(() => { const a = size(opts.dbPath); return a === null ? null : a + (size(opts.dbPath + "-wal") ?? 0); });
  const cpu = safe(() => { const c = o.cpus(); return c.length ? `${c[0].model.replace(/\s+/g, " ").trim()} x${c.length}` : null; });
  return {
    computer_name: safe(() => o.hostname()), operating_system: safe(() => osName(d)), cpu,
    memory_used_bytes: safe(() => o.totalmem() - o.freemem()), memory_total_bytes: safe(() => o.totalmem()), disk_free_bytes: disk?.free ?? null, disk_total_bytes: disk?.total ?? null,
    uptime_s: safe(() => Math.round(o.uptime())), ip_addresses: safe(() => ipv4Addresses(o, read)), time_zone: safe(() => opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || null),
    node_version: safe(() => d.nodeVersion ?? process.version), sqlite_version: safe(() => String((db.prepare("select sqlite_version() v").get() as { v: string }).v)), database_bytes: dbSize,
    serial_ports: await safeAsync(() => (d.serialPorts ?? (() => Promise.resolve([] as string[])))()), data_folder: opts.dataDir ?? null, platform,
  };
}

/** Serial ports as plain names. Windows: SerialPort.list() (COM3...). Linux: the existing /dev listing. A missing serialport module or a driver error gives an empty list. */
export async function listSerialNames(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "win32") { try { const { SerialPort } = await import("serialport"); return ((await SerialPort.list()) as { path: string }[]).map((p) => p.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); } catch { return []; } }
  try { const { listSerial } = await import("../ports/available.js"); return listSerial().map((p) => p.path); } catch { return []; }
}
