import { isWin, type Platform } from "../platform.js";
import { canonicalSerialPath } from "./serialPath.js";
// RS-485 Ports: pure validation (no database, no sockets), so it is unit-tested on its own. Everything here returns a list of plain-English errors.
export const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;
export const PARITIES = ["none", "even", "odd"] as const;
export const DEVICE_KINDS = ["lora_gateway", "weather", "fan_link", "io_module"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
/** Gateway (XZ-DS-MUS2) addresses that must never be used: 0 and 255 are broadcast / reserved, 123 and 160 are known to clash (owner rule). */
export const FORBIDDEN_GATEWAY_ADDR = new Set([0, 123, 160, 255]);

export interface PortRow {
  id: number; label: string; enabled: boolean; transport: "serial" | "tcp"; device_path: string; tcp_host: string; tcp_port: number;
  /** Only for transport tcp: "rtu" = RTU over TCP (RS-485-to-Ethernet converter), "mbap" = Modbus TCP (the bench gateway simulator). */
  tcp_framing: "rtu" | "mbap";
  baud: number; data_bits: number; parity: "none" | "even" | "odd"; stop_bits: number; timeout_ms: number; retries: number; turnaround_ms: number;
}
export interface DeviceRow { id: number; kind: DeviceKind; model: string; port_id: number; modbus_address: number; poll_interval_s: number; enabled: boolean; }

export const PORT_DEFAULTS = { baud: 9600, data_bits: 8, parity: "none", stop_bits: 1, timeout_ms: 1000, retries: 2, turnaround_ms: 50 } as const;

const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** Only real device nodes under /dev: no relative paths, no "..", no spaces. */
export const DEVICE_PATH = /^\/dev\/[A-Za-z0-9_.:@+-]+(?:\/[A-Za-z0-9_.:@+-]+)*$/;

/** Is this a serial device name for the given platform? Linux: a node under /dev. Windows: COMn. Used by validatePort and by the cross-platform restore. */
export const serialPathValid = (path: string, platform: Platform = process.platform): boolean => (isWin(platform) ? !!canonicalSerialPath(path, platform) : DEVICE_PATH.test(path) && !path.split("/").includes(".."));
export const PATH_INVALID_HERE = "port path not valid on this platform, please reassign";

export function validatePort(p: PortRow, platform: Platform = process.platform): string[] {
  const e: string[] = [];
  if (![1, 2].includes(p.id) && !(Number.isInteger(p.id) && p.id > 0 && p.id < 10)) e.push("port id must be 1 to 9");
  if (!p.label || p.label.length > 60) e.push("name must be 1 to 60 characters");
  if (p.transport !== "serial" && p.transport !== "tcp") e.push("connection type must be Serial device or TCP");
  if (!(BAUDS as readonly number[]).includes(p.baud)) e.push("baud rate must be one of " + BAUDS.join(", "));
  if (p.data_bits !== 8) e.push("data bits must be 8");
  if (!(PARITIES as readonly string[]).includes(p.parity)) e.push("parity must be none, even or odd");
  if (p.stop_bits !== 1 && p.stop_bits !== 2) e.push("stop bits must be 1 or 2");
  if (!intIn(p.timeout_ms, 100, 10000)) e.push("response timeout must be 100 to 10000 ms");
  if (!intIn(p.retries, 0, 5)) e.push("retries must be 0 to 5");
  if (!intIn(p.turnaround_ms, 0, 1000)) e.push("turnaround delay must be 0 to 1000 ms");
  if (p.enabled && p.transport === "serial") {
    if (!p.device_path) e.push("choose a serial device");
    else if (isWin(platform)) { if (!canonicalSerialPath(p.device_path, platform)) e.push("serial port must be a COM port name, for example COM3 or COM10"); }   // Windows (W1)
    else if (!DEVICE_PATH.test(p.device_path) || p.device_path.split("/").includes("..")) e.push("serial device must be a path under /dev, for example /dev/serial/by-id/usb-...");
  }
  if (p.transport === "tcp" && p.enabled) {
    if (!p.tcp_host || p.tcp_host.length > 253 || !HOST.test(p.tcp_host)) e.push("TCP host must be a host name or an IP address");
    if (!intIn(p.tcp_port, 1, 65535)) e.push("TCP port must be 1 to 65535");
  }
  if (p.tcp_framing !== "rtu" && p.tcp_framing !== "mbap") e.push("TCP framing must be rtu or mbap");
  return e;
}

/** Cross-port rules: two enabled ports must not use the same serial device (or the same TCP target). */
export function validatePorts(ports: PortRow[], platform: Platform = process.platform): string[] {
  const e: string[] = []; const seen = new Map<string, number>();
  for (const p of ports) {
    if (!p.enabled) continue; const key = p.transport === "serial" ? (p.device_path ? "s:" + (canonicalSerialPath(p.device_path, platform) ?? p.device_path) : "") : `t:${p.tcp_host}:${p.tcp_port}`; if (!key) continue;
    const other = seen.get(key); if (other !== undefined) e.push(`Port ${other} and Port ${p.id} use the same ${p.transport === "serial" ? "serial device" : "TCP target"}: each port needs its own`); else seen.set(key, p.id);
  }
  return e;
}

export function validateDevice(d: DeviceRow, ports: PortRow[]): string[] {
  const e: string[] = [];
  if (!(DEVICE_KINDS as readonly string[]).includes(d.kind)) e.push("unknown device kind");
  if (!ports.some((p) => p.id === d.port_id)) e.push("port " + d.port_id + " does not exist");
  if (!intIn(d.modbus_address, 1, d.kind === "lora_gateway" ? 254 : 247)) e.push(`Modbus address must be 1 to ${d.kind === "lora_gateway" ? 254 : 247}`);
  if (d.kind === "lora_gateway" && FORBIDDEN_GATEWAY_ADDR.has(d.modbus_address)) e.push("the gateway address must never be 0, 123, 160 or 255");
  if (!intIn(d.poll_interval_s, 5, 3600)) e.push("poll interval must be 5 to 3600 s");
  return e;
}

/** Devices on one port must have different addresses. Disabled devices do not count. */
export function validateAssignment(devices: DeviceRow[]): string[] {
  const e: string[] = []; const seen = new Map<string, DeviceRow>();
  for (const d of devices) {
    if (!d.enabled) continue; const k = d.port_id + ":" + d.modbus_address; const o = seen.get(k);
    if (o) e.push(`${o.model} and ${d.model} both use address ${d.modbus_address} on Port ${d.port_id}: addresses on one port must differ`); else seen.set(k, d);
  }
  return e;
}

/** Shared-bus rules, shown as a warning card (not an error) when two enabled devices sit on one port. */
export const SHARED_BUS_RULES = ["One RS-485 line, daisy-chained from device to device (no star wiring).", "Termination resistor at BOTH ends of the line, nowhere else.", "A different Modbus address on every device.", "The same baud rate and parity on every device."];
export const sharedPorts = (devices: DeviceRow[]) => { const n = new Map<number, number>(); for (const d of devices) if (d.enabled) n.set(d.port_id, (n.get(d.port_id) ?? 0) + 1); return [...n].filter(([, c]) => c > 1).map(([id]) => id); };

/** Accepts the loose JSON an API client sends and returns a complete row (missing fields keep the old value). Throws nothing: validatePort reports problems. */
export function mergePort(old: PortRow, patch: Record<string, any>, platform: Platform = process.platform): PortRow {
  const n = (k: keyof PortRow) => (patch[k] === undefined || patch[k] === null || patch[k] === "" ? old[k] : Number(patch[k]));
  const s = (k: keyof PortRow) => (patch[k] === undefined || patch[k] === null ? String(old[k]) : String(patch[k]).trim());
  return { id: old.id, label: s("label"), enabled: patch.enabled === undefined ? old.enabled : !!patch.enabled, transport: s("transport") as PortRow["transport"], device_path: canonicalSerialPath(s("device_path"), platform) ?? s("device_path"), tcp_host: s("tcp_host"), tcp_port: n("tcp_port") as number,
    tcp_framing: s("tcp_framing") as PortRow["tcp_framing"], baud: n("baud") as number, data_bits: n("data_bits") as number, parity: s("parity") as PortRow["parity"], stop_bits: n("stop_bits") as number, timeout_ms: n("timeout_ms") as number, retries: n("retries") as number, turnaround_ms: n("turnaround_ms") as number };
}
export function mergeDevice(old: DeviceRow, patch: Record<string, any>): DeviceRow {
  const n = (k: keyof DeviceRow) => (patch[k] === undefined || patch[k] === null || patch[k] === "" ? (old[k] as number) : Number(patch[k]));
  return { ...old, port_id: n("port_id"), modbus_address: n("modbus_address"), poll_interval_s: n("poll_interval_s"), enabled: patch.enabled === undefined ? old.enabled : !!patch.enabled };
}
