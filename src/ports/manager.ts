// PortManager: one request queue per RS-485 port, devices bound to their port, apply-without-restart with TEST and REVERT.
// The two ports run independently (separate queues and transports), so a fault on one never delays the other. Polling is never left off.
import { EventEmitter } from "node:events";
import { audit, type Db } from "../db.js";
import { ModbusException, ModbusTimeout } from "../drivers/modbus/frames.js";
import { GatewayDriver } from "../drivers/modbus/driver.js";
import { ModbusMaster, PortQueue } from "../drivers/modbus/master.js";
import type { RegMap } from "../drivers/modbus/regmap.js";
import { createTransport, type ModbusTransport } from "../drivers/modbus/transport.js";
import type { GatewayService } from "../gateway/service.js";
import { HttpError, type Actor } from "../gateway/registry.js";
import { errorText, listSerial, listSerialWin, refreshSerialCache, serialPresent } from "./available.js";
import { serialOpenPath } from "./serialPath.js";
import { isWin } from "../platform.js";
import { PortStore } from "./store.js";
import { mergeDevice, mergePort, sharedPorts, SHARED_BUS_RULES, serialPathValid, PATH_INVALID_HERE, validateAssignment, validateDevice, validatePort, validatePorts, type DeviceRow, type PortRow } from "./validate.js";

export type TestResult = { deviceId: number; model: string; address: number; result: "ok" | "no_answer" | "crc_error" | "error" | "not_connected"; ms: number | null; detail?: string };
export type DeviceState = "online" | "offline" | "not_connected" | "unknown";
export const REVERT_WINDOW_MS = 30_000;

/** A line that is switched off or not configured: every request fails at once, nothing is opened. */
class ClosedTransport implements ModbusTransport {
  constructor(private why: string) {}
  request(): Promise<Buffer> { return Promise.reject(new Error(this.why)); }
  async close() {}
}

interface Pending { ports: PortRow[]; devices: DeviceRow[]; deadline: number; timer: NodeJS.Timeout; }
interface Poller { timer?: NodeJS.Timeout; fails: number; state: DeviceState; lastOk: number | null; lastMs: number | null; stopped: boolean; }

export class PortManager extends EventEmitter {
  private queues = new Map<number, PortQueue>(); private masters = new Map<number, ModbusMaster>(); private pollers = new Map<number, Poller>();
  private drv: GatewayDriver | null = null; private pending: Pending | null = null; private stopped = false; private busy = false;
  constructor(private db: Db, public store: PortStore, private map: RegMap | null, private gw: GatewayService | null) { super(); }

  // ---------- lifecycle ----------
  async start() {
    for (const p of this.store.ports()) await this.build(p);
    await this.bind(); this.startPollers(); this.emit("update");
  }
  async stop() { this.stopped = true; if (this.pending) clearTimeout(this.pending.timer); this.stopPollers(); for (const q of this.queues.values()) await q.tr.close().catch(() => {}); }

  private transportFor(p: PortRow): ModbusTransport {
    if (!p.enabled) return new ClosedTransport("port is switched off");
    if (p.transport === "serial") return createTransport({ type: "rtu-serial", path: serialOpenPath(p.device_path), baud: p.baud, parity: p.parity, dataBits: 8, stopBits: p.stop_bits as 1 | 2 });
    return createTransport({ type: p.tcp_framing === "mbap" ? "tcp" : "rtu-tcp", host: p.tcp_host, port: p.tcp_port });
  }
  private async build(p: PortRow) {
    const tr = this.transportFor(p), opts = { timeoutMs: p.timeout_ms, retries: p.retries, turnaroundMs: p.turnaround_ms }; const q = this.queues.get(p.id);
    if (!q) this.queues.set(p.id, new PortQueue(tr, opts)); else { await q.replace(tr, opts); q.stats = { requests: 0, errors: 0, lastOk: null, lastError: null, lastErrorKind: null, lastErrAt: null }; }
  }
  /** Masters follow their device's port and address; the gateway service gets a driver on the right master (or none = NOT CONNECTED). */
  private async bind() {
    const ports = this.store.ports(); let gwMaster: ModbusMaster | null = null;
    for (const d of this.store.devices()) {
      const q = this.queues.get(d.port_id); if (!q) continue; let m = this.masters.get(d.id);
      if (!m || m.queue !== q) { m = new ModbusMaster(q, { unit: d.modbus_address, timeoutMs: q.opts.timeoutMs, retries: q.opts.retries }); this.masters.set(d.id, m); } else m.setUnit(d.modbus_address);
      if (d.kind === "lora_gateway" && d.enabled && ports.find((p) => p.id === d.port_id)?.enabled) gwMaster = m;
    }
    if (!this.gw || !this.map) return;
    if (!gwMaster) { if (this.drv) { this.drv = null; await this.gw.rebind(null); } return; }
    if (!this.drv || this.drv.master !== gwMaster) { this.drv = new GatewayDriver(gwMaster, this.map); await this.gw.rebind(this.drv); }
  }
  private stopPollers() { for (const p of this.pollers.values()) { p.stopped = true; clearTimeout(p.timer); } this.pollers.clear(); }
  /** Devices without a register-map driver yet (weather station, later fan link and I/O module) get a liveness poll: a status read every poll interval, so the lamp is real. */
  private startPollers() {
    this.stopPollers(); const ports = this.store.ports();
    for (const d of this.store.devices()) {
      if (d.kind === "lora_gateway") continue; const p: Poller = { fails: 0, state: "unknown", lastOk: null, lastMs: null, stopped: false }; this.pollers.set(d.id, p);
      const run = async () => {
        if (p.stopped || this.stopped) return; const cur = this.store.device(d.id), port = cur && ports.find((x) => x.id === cur.port_id);
        if (cur?.enabled && port?.enabled && !this.busy) { const r = await this.probe(cur); if (!p.stopped) { if (r.result === "ok") { p.fails = 0; p.state = "online"; p.lastOk = Date.now(); p.lastMs = r.ms; } else if (++p.fails >= 3) p.state = "offline"; this.emit("update"); } }
        if (!p.stopped) p.timer = setTimeout(run, Math.max(5, cur?.poll_interval_s ?? d.poll_interval_s) * 1000);
      };
      p.timer = setTimeout(run, 500 + d.id * 300);
    }
  }

  // ---------- probing ----------
  /** One status read. A device exception reply counts as OK (the device answered). Timeouts with garbage on the line are reported as a CRC error. */
  async probe(d: DeviceRow): Promise<TestResult> {
    const base = { deviceId: d.id, model: d.model, address: d.modbus_address }; const port = this.store.port(d.port_id), q = this.queues.get(d.port_id), m = this.masters.get(d.id);
    if (!d.enabled || !port?.enabled || !q || !m) return { ...base, result: "not_connected", ms: null, detail: !port?.enabled ? "port is switched off" : "device is switched off" };
    const bad0 = q.tr.badFrames?.() ?? 0, t0 = Date.now();
    try {
      if (d.kind === "lora_gateway" && this.map) await m.read(this.map.system.read_fc as 3 | 4, this.map.system.address, 1, "write"); else await m.read(3, 0, 1, "write");
      return { ...base, result: "ok", ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof ModbusException) return { ...base, result: "ok", ms: Date.now() - t0, detail: "answered with exception " + e.code };
      if (e instanceof ModbusTimeout) return { ...base, result: (q.tr.badFrames?.() ?? 0) > bad0 ? "crc_error" : "no_answer", ms: null, detail: q.stats.lastError ?? undefined };
      return { ...base, result: "error", ms: null, detail: errorText(e, port) };
    }
  }
  async test(id: number): Promise<{ port: ReturnType<PortManager["portView"]>; results: TestResult[] }> {
    if (!this.store.port(id)) throw new HttpError(404, "port not found");
    const results: TestResult[] = []; for (const d of this.store.devices().filter((x) => x.port_id === id)) results.push(await this.probe(d));
    return { port: this.portView(this.store.port(id)!), results };
  }

  // ---------- status ----------
  deviceState(d: DeviceRow): DeviceState {
    const port = this.store.port(d.port_id); if (!d.enabled || !port?.enabled) return "not_connected";
    if (d.kind === "lora_gateway") { if (!this.gw?.drv) return "not_connected"; if (this.gw.online) return "online"; return this.gw.lastOk === null && this.gw.failCycles === 0 ? "unknown" : "offline"; }
    return this.pollers.get(d.id)?.state ?? "unknown";
  }
  portView(p: PortRow) {
    const q = this.queues.get(p.id), st = q?.stats; let status: "OPEN" | "CLOSED" | "ERROR" | "NOT FOUND" = "OPEN"; let lastError = st?.lastError ? errorText(st.lastError, p) : null;
    if (!p.enabled) { status = "CLOSED"; if (p.transport === "serial" && p.device_path && !serialPathValid(p.device_path)) lastError = PATH_INVALID_HERE + ` (${p.device_path})`; }
    else if (p.transport === "serial" && (!p.device_path || !serialPresent(p.device_path))) { status = "NOT FOUND"; lastError = p.device_path ? errorText(new Error("ENOENT"), p) : "No serial device chosen."; }
    else if (st?.lastErrorKind === "io" && (st.lastOk === null || st.lastOk < st.lastErrAt!)) status = "ERROR";
    return { ...p, status, lastError, counters: { requests: st?.requests ?? 0, errors: st?.errors ?? 0, lastOk: st?.lastOk ?? null }, devices: this.store.devices().filter((d) => d.port_id === p.id).length, pending: q?.pending() ?? 0 };
  }
  view() {
    const devices = this.store.devices(); const ports = this.store.ports();
    return { platform: process.platform, ports: ports.map((p) => this.portView(p)), devices: devices.map((d) => ({ ...d, state: this.deviceState(d), lastOk: d.kind === "lora_gateway" ? this.gw?.lastOk ?? null : this.pollers.get(d.id)?.lastOk ?? null, lastMs: this.pollers.get(d.id)?.lastMs ?? null })),
      shared: sharedPorts(devices), sharedRules: SHARED_BUS_RULES, pending: this.pending ? { deadline: this.pending.deadline, ports: this.pending.ports.map((p) => p.id) } : null, revertWindowSec: REVERT_WINDOW_MS / 1000 };
  }
  available() { return isWin() ? listSerialWin() : listSerial(); }
  /** Windows only (no-op on Linux): refresh the COM-port list the NOT FOUND check reads, so portView() can stay synchronous. */
  refreshSerial() { return refreshSerialCache(); }
  /** Read-only summary for the Sensors Gateway page. */
  gatewayLink() {
    const d = this.store.devices().find((x) => x.kind === "lora_gateway"); if (!d) return null; const p = this.store.port(d.port_id); if (!p) return null;
    return { portId: p.id, portLabel: p.label, enabled: p.enabled && d.enabled, transport: p.transport, host: p.tcp_host, port: p.tcp_port, serialPath: p.device_path, baud: p.baud, parity: p.parity, dataBits: p.data_bits, stopBits: p.stop_bits,
      line: `${p.baud} ${p.data_bits}${p.parity === "none" ? "N" : p.parity === "even" ? "E" : "O"}${p.stop_bits}`, address: d.modbus_address, timeoutMs: p.timeout_ms, retries: p.retries };
  }
  /** After the Admin changes the gateway's own address on the gateway page, the stored address follows so a restart keeps it. */
  syncGatewayAddress(addr: number) {
    const d = this.store.devices().find((x) => x.kind === "lora_gateway"); if (!d || d.modbus_address === addr) return; this.store.saveDevice({ ...d, modbus_address: addr }); this.masters.get(d.id)?.setUnit(addr); this.emit("update");
  }

  // ---------- changes ----------
  /** The common path for every change: pause polling of what is affected, apply, TEST, resume. A device that WAS online and is not answering afterwards leaves a 30 s window to KEEP or REVERT. */
  private async change(a: Actor, action: string, next: { ports: PortRow[]; devices: DeviceRow[] }, detail: unknown) {
    if (this.pending) throw new HttpError(409, "a changed setting is waiting to be kept or reverted: press KEEP THESE SETTINGS or REVERT first");
    if (this.busy) throw new HttpError(409, "another change is being applied");
    this.busy = true;
    const prevPorts = next.ports.map((p) => this.store.port(p.id)!), prevDevices = this.store.devices().filter((d) => next.devices.some((n) => n.id === d.id) || next.ports.some((p) => p.id === d.port_id));
    const affected = (): DeviceRow[] => { const ids = new Set(next.devices.map((d) => d.id)); return this.store.devices().filter((d) => ids.has(d.id) || next.ports.some((p) => p.id === d.port_id) || prevDevices.some((x) => x.id === d.id)); };
    const onlineBefore = new Set(affected().filter((d) => this.deviceState(d) === "online").map((d) => d.id));
    try {
      this.stopPollers(); await this.gw?.pause();
      this.applyRows(next, a.username); await this.rebuild(next.ports.map((p) => p.id));
      audit(this.db, a.username, a.role, action, detail);
      const results: TestResult[] = []; for (const d of affected()) results.push(await this.probe(d));
      const failed = results.filter((r) => onlineBefore.has(r.deviceId) && r.result !== "ok");
      if (!failed.length) {
        // last_good only ever holds settings that answered: a port whose devices are silent for another reason (already offline before) keeps its older snapshot.
        for (const p of next.ports) if (results.filter((r) => this.store.device(r.deviceId)?.port_id === p.id).every((r) => r.result === "ok" || r.result === "not_connected")) this.store.setLastGood(p.id, this.store.port(p.id)!);
        return { ok: true, results, pending: null };
      }
      const t = setTimeout(() => { void this.revert({ username: "system", role: "system" }, undefined, "no confirmation within 30 s").catch(() => {}); }, REVERT_WINDOW_MS); t.unref();
      this.pending = { ports: prevPorts, devices: prevDevices, deadline: Date.now() + REVERT_WINDOW_MS, timer: t };
      audit(this.db, a.username, a.role, "ports.change.unconfirmed", { failed: failed.map((f) => `${f.model}:${f.result}`) });
      return { ok: true, results, pending: { deadline: this.pending.deadline, failed: failed.map((f) => f.model) } };
    } finally {
      this.busy = false; this.startPollers(); this.gw?.resume(); this.emit("update");        // polling is never left off
    }
  }
  private applyRows(next: { ports: PortRow[]; devices: DeviceRow[] }, by: string) { for (const p of next.ports) this.store.savePort(p, by); for (const d of next.devices) this.store.saveDevice(d); }
  private async rebuild(portIds: number[]) { for (const id of portIds) { const p = this.store.port(id); if (p) await this.build(p); } await this.bind(); }

  async applyPort(a: Actor, id: number, patch: Record<string, any>) {
    const old = this.store.port(id); if (!old) throw new HttpError(404, "port not found"); const merged = mergePort(old, patch ?? {});
    const errs = [...validatePort(merged), ...validatePorts(this.store.ports().map((p) => (p.id === id ? merged : p)))]; if (errs.length) throw new HttpError(400, errs.join("; "), { errors: errs });
    const diff = (k: keyof PortRow) => old[k] !== merged[k]; const keys = (Object.keys(merged) as (keyof PortRow)[]).filter(diff);
    if (!keys.length) return { ok: true, results: [], pending: null, unchanged: true };
    return this.change(a, "ports.update", { ports: [merged], devices: [] }, { port: id, old: Object.fromEntries(keys.map((k) => [k, old[k]])), new: Object.fromEntries(keys.map((k) => [k, merged[k]])) });
  }
  async applyDevice(a: Actor, id: number, patch: Record<string, any>) {
    const old = this.store.device(id); if (!old) throw new HttpError(404, "device not found"); const merged = mergeDevice(old, patch ?? {}); const ports = this.store.ports();
    const errs = [...validateDevice(merged, ports), ...validateAssignment(this.store.devices().map((d) => (d.id === id ? merged : d)))]; if (errs.length) throw new HttpError(400, errs.join("; "), { errors: errs });
    const keys = (Object.keys(merged) as (keyof DeviceRow)[]).filter((k) => old[k] !== merged[k]); if (!keys.length) return { ok: true, results: [], pending: null, unchanged: true };
    return this.change(a, "devices.update", { ports: [], devices: [merged] }, { device: old.kind, old: Object.fromEntries(keys.map((k) => [k, old[k]])), new: Object.fromEntries(keys.map((k) => [k, merged[k]])) });
  }
  /** REVERT: undo the unconfirmed change (or, with nothing pending, go back to the last settings that worked). */
  async revert(a: Actor, portId?: number, why?: string) {
    if (this.busy) throw new HttpError(409, "another change is being applied"); this.busy = true;
    try {
      this.stopPollers(); await this.gw?.pause();
      let ports: PortRow[], devices: DeviceRow[];
      if (this.pending) { clearTimeout(this.pending.timer); ports = this.pending.ports; devices = this.pending.devices; this.pending = null; }
      else { if (portId === undefined) throw new HttpError(409, "nothing to revert"); const g = this.store.lastGood(portId); if (!g) throw new HttpError(409, "no earlier working settings are stored for this port"); ports = [g]; devices = []; }
      this.applyRows({ ports, devices }, a.username); await this.rebuild(ports.map((p) => p.id));
      for (const p of ports) this.store.setLastGood(p.id, this.store.port(p.id)!);
      audit(this.db, a.username, a.role, "ports.revert", { ports: ports.map((p) => p.id), devices: devices.map((d) => d.kind), reason: why ?? "requested" });
      const results: TestResult[] = []; for (const d of this.store.devices().filter((x) => ports.some((p) => p.id === x.port_id) || devices.some((y) => y.id === x.id))) results.push(await this.probe(d));
      return { ok: true, results };
    } finally { this.busy = false; this.startPollers(); this.gw?.resume(); this.emit("update"); }
  }
  /** KEEP THESE SETTINGS: the pending change becomes the new last-working state. */
  keep(a: Actor) {
    if (!this.pending) throw new HttpError(409, "nothing is waiting to be kept"); clearTimeout(this.pending.timer);
    for (const p of this.pending.ports) this.store.setLastGood(p.id, this.store.port(p.id)!);
    audit(this.db, a.username, a.role, "ports.keep", { ports: this.pending.ports.map((p) => p.id) }); this.pending = null; this.emit("update"); return { ok: true };
  }

  // ---------- backup ----------
  exportParts() { const e = this.store.exportAll(); return { ports: e.ports, devices: e.devices }; }
  /**
   * Validates the ports/devices part of a backup and returns warnings (empty list when there is nothing to say).
   * Cross-platform restore (W1 follow-up): an ENABLED serial port whose device path cannot exist on this platform (a /dev path on Windows, a COM name on
   * Linux) must not fail the whole restore. It is switched to DISABLED inside `b` (the same object restoreParts then stores), its path is kept so the Admin
   * can see what it was, and a warning says to reassign it. Every other validation problem still refuses the restore.
   */
  checkBackup(b: any, platform = process.platform): string[] {
    if (b?.ports === undefined && b?.devices === undefined) return []; const ports = b.ports as PortRow[], devices = b.devices as DeviceRow[];
    if (!Array.isArray(ports) || !Array.isArray(devices)) throw new HttpError(400, "backup: ports and devices must be lists");
    const warnings: string[] = [];
    for (const p of ports) if (p && p.transport === "serial" && p.enabled && typeof p.device_path === "string" && p.device_path && !serialPathValid(p.device_path, platform)) {
      p.enabled = false; warnings.push(`Port ${p.id}${p.label ? ` (${p.label})` : ""} was disabled: ${PATH_INVALID_HERE} (was ${p.device_path}).`);
    }
    const errs = [...ports.flatMap((p) => validatePort({ ...p, enabled: !!p.enabled }, platform)), ...validatePorts(ports, platform), ...devices.flatMap((d) => validateDevice(d, ports)), ...validateAssignment(devices)];
    if (errs.length) throw new HttpError(400, "backup: " + errs.join("; "));
    return warnings;
  }
  /** After a restore on a new box the device path may differ: the port then shows NOT FOUND until the Admin picks the device again. */
  async restoreParts(a: Actor, b: any, warnings: string[] = []) {
    if (b?.ports === undefined && b?.devices === undefined) return; this.store.replaceAll(b.ports, b.devices, a.username);
    this.stopPollers(); for (const p of this.store.ports()) await this.build(p); this.masters.clear(); this.drv = null; await this.bind(); this.startPollers();
    audit(this.db, a.username, a.role, "ports.restore", { ports: b.ports.length, devices: b.devices.length, ...(warnings?.length ? { warnings } : {}) }); this.emit("update");
  }
}
