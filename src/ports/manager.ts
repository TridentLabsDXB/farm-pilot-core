// PortManager: one request queue per RS-485 port, devices bound to their port, apply-without-restart with TEST and REVERT.
// The two ports run independently (separate queues and transports), so a fault on one never delays the other. Polling is never left off.
import { EventEmitter } from "node:events";
import { audit, type Db } from "../db.js";
import { ModbusException, ModbusTimeout } from "../drivers/modbus/frames.js";
import { GatewayDriver } from "../drivers/modbus/driver.js";
import { ModbusMaster, PortQueue } from "../drivers/modbus/master.js";
import type { RegMap } from "../drivers/modbus/regmap.js";
import { createTransport, SerialOpenError, type ModbusTransport } from "../drivers/modbus/transport.js";
import type { GatewayService } from "../gateway/service.js";
import { HttpError, type Actor } from "../gateway/registry.js";
import { errorText, listSerial, listSerialWin, refreshSerialCache, serialPresent } from "./available.js";
import { canonicalSerialPath, serialOpenPath } from "./serialPath.js";
import { isWin } from "../platform.js";
import { PortStore } from "./store.js";
import { mergeDevice, mergePort, sharedPorts, SHARED_BUS_RULES, serialPathValid, PATH_INVALID_HERE, validateAssignment, validateDevice, validatePort, validatePorts, type DeviceRow, type PortRow } from "./validate.js";

export type TestResult = { deviceId: number; model: string; address: number; result: "ok" | "no_answer" | "crc_error" | "error" | "not_connected" | "off" | "open_error" | "invalid"; ms: number | null; detail?: string };
/** One plain sentence for the Ports page. It is built from the REAL results, so "tested" is never printed for a test that did not run (Windows lab 2026-11-17: "Saved. The port was reopened and tested." with 0 / 0 counters). */
export interface TestSummary { tone: "ok" | "warn" | "err"; text: string; }
export type PortStatus = "OPEN" | "CLOSED" | "ERROR" | "NOT FOUND" | "ACCESS DENIED" | "NOT OPEN";
/** An OPEN port with no request at all for this long while a device is assigned is shown as OPEN, NOT POLLED (amber). */
export const NOT_POLLED_AFTER_MS = 60_000;
const WORD: Record<string, string> = { ok: "OK", no_answer: "NO ANSWER", crc_error: "CRC ERROR", error: "ERROR", not_connected: "NOT CONNECTED", off: "SWITCHED OFF", open_error: "CANNOT OPEN", invalid: "INVALID SETTINGS" };
export function summarize(kind: "save" | "test-saved" | "test-draft" | "revert", results: TestResult[], extra?: { openOk?: boolean; openText?: string; portOn?: boolean; portLabel?: string }): TestSummary {
  const part = (r: TestResult) => (r.result === "ok" ? `${r.model} (address ${r.address}) OK, ${r.ms} ms` : `${r.model}${r.address ? ` (address ${r.address})` : ""} ${WORD[r.result] ?? r.result}${r.detail ? ": " + r.detail : ""}`);
  const ok = results.length > 0 && results.every((r) => r.result === "ok"), allOff = results.length > 0 && results.every((r) => r.result === "off");
  if (!results.length) {
    if (extra?.portOn === false) return { tone: "warn", text: kind === "save" ? "Saved. The port is switched off, so nothing was opened and nothing was tested." : "The port is switched off, so nothing was opened and nothing was tested." };
    if (extra?.openOk === false) return { tone: "err", text: (kind === "save" ? "Saved, but " : "") + (extra.openText ?? "the port could not be opened") + "." };
    return { tone: "warn", text: (kind === "save" ? "Saved. " : "") + (extra?.openText ? extra.openText + ". " : "") + "No device is assigned to this port, so no request was sent and nothing was tested." };
  }
  const body = results.map(part).join("; ") + ".";
  if (kind === "save") return ok ? { tone: "ok", text: `Saved. The port was reopened and tested: ${body}` } : { tone: allOff ? "warn" : "err", text: `Saved, but the test did not pass: ${body}` };
  if (kind === "revert") return ok ? { tone: "ok", text: `Reverted to the last working settings: ${body}` } : { tone: allOff ? "warn" : "err", text: `Reverted, but the test did not pass: ${body}` };
  const lead = kind === "test-draft" ? "Tested the settings shown in the form (NOT saved yet)" : "Tested the saved settings";
  return { tone: ok ? "ok" : allOff ? "warn" : "err", text: `${lead}: ${body}` };
}
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
  private builtAt = new Map<number, number>();
  /** Test hook: how long an OPEN port may stay without a single request before it shows NOT POLLED. */
  notPolledAfterMs = NOT_POLLED_AFTER_MS;
  /**
   * (Re)creates the port's transport. A serial port is OPENED here (not lazily on the first request): the lamp then reports a real handle, and a wrong COM name or a busy port is an
   * error on the page at once. wait = true (SAVE, TEST) waits up to 5 s for the open result; at start-up the open runs in the background.
   */
  private async build(p: PortRow, wait = false) {
    const tr = this.transportFor(p), opts = { timeoutMs: p.timeout_ms, retries: p.retries, turnaroundMs: p.turnaround_ms }; const q = this.queues.get(p.id);
    if (!q) this.queues.set(p.id, new PortQueue(tr, opts)); else { await q.replace(tr, opts); q.stats = { requests: 0, errors: 0, lastOk: null, lastError: null, lastErrorKind: null, lastErrAt: null }; }
    this.builtAt.set(p.id, Date.now());
    if (p.enabled && p.transport === "serial" && tr.openNow) { const o = tr.openNow().catch(() => {}); if (wait) await Promise.race([o, new Promise((r) => setTimeout(r, 5000))]); }
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
  async probe(d: DeviceRow): Promise<TestResult> { return this.probeOn(d, this.store.port(d.port_id), this.queues.get(d.port_id), this.masters.get(d.id)); }
  private async probeOn(d: DeviceRow, port: PortRow | undefined, q: PortQueue | undefined, m: ModbusMaster | undefined): Promise<TestResult> {
    const base = { deviceId: d.id, model: d.model, address: d.modbus_address };
    if (!port?.enabled) return { ...base, result: "off", ms: null, detail: "port is switched off" };
    if (!d.enabled) return { ...base, result: "off", ms: null, detail: "device is switched off (Devices on ports > Enabled)" };
    if (!q || !m) return { ...base, result: "not_connected", ms: null, detail: "no connection object for this device" };
    const bad0 = q.tr.badFrames?.() ?? 0, t0 = Date.now();
    try {
      if (d.kind === "lora_gateway" && this.map) await m.read(this.map.system.read_fc as 3 | 4, this.map.system.address, 1, "write"); else await m.read(3, 0, 1, "write");
      return { ...base, result: "ok", ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof ModbusException) return { ...base, result: "ok", ms: Date.now() - t0, detail: "answered with exception " + e.code };
      if (e instanceof SerialOpenError) { const f = errorText(e, port); return { ...base, result: "open_error", ms: null, detail: f === e.message ? e.message : `${e.message} - ${f}` }; }
      if (e instanceof ModbusTimeout) return { ...base, result: (q.tr.badFrames?.() ?? 0) > bad0 ? "crc_error" : "no_answer", ms: null, detail: q.stats.lastError ?? undefined };
      return { ...base, result: "error", ms: null, detail: errorText(e, port) };
    }
  }
  /** What the OS handle of a serial port says now: ok, or the text of the failed open. TCP ports have no handle to report. */
  private openState(p: PortRow): { openOk: boolean | undefined; openText?: string } {
    const ls = this.queues.get(p.id)?.tr.linkState?.(); if (p.transport !== "serial" || !ls) return { openOk: undefined };
    if (ls.state === "open") return { openOk: true, openText: `${p.device_path} is open` };
    if (ls.state === "error") return { openOk: false, openText: `could not open ${p.device_path}: ${ls.error}` };
    return { openOk: false, openText: `${p.device_path} is not open` };
  }
  /**
   * TEST PORT. Always returns something the page can show: a result row per device plus one plain sentence (summary). With `draft` (the form values, saved or not) the test runs on THOSE settings:
   * the live line is released, a temporary transport is opened, every device on the port is asked once, the temporary line is closed and the saved settings are put back. Nothing is stored.
   * Without a draft, or when the draft equals what is saved, the live line is used and re-opened first if it is not open.
   */
  async test(id: number, draft?: { port?: Record<string, any>; devices?: Record<string, Record<string, any>> }) {
    const old = this.store.port(id); if (!old) throw new HttpError(404, "port not found");
    const merged = draft?.port ? mergePort(old, draft.port) : old; const stored = this.store.devices().filter((d) => d.port_id === id);
    const devs = this.store.devices().map((d) => (draft?.devices?.[String(d.id)] ? mergeDevice(d, draft.devices[String(d.id)]) : d)).filter((d) => d.port_id === id);
    const changed = (Object.keys(merged) as (keyof PortRow)[]).some((k) => merged[k] !== old[k]) || JSON.stringify(devs) !== JSON.stringify(stored);
    let results: TestResult[] = []; let extra: { openOk?: boolean; openText?: string; portOn?: boolean } = { portOn: merged.enabled };
    const errs = changed ? [...validatePort(merged), ...validatePorts(this.store.ports().map((p) => (p.id === id ? merged : p))), ...devs.flatMap((d) => validateDevice(d, this.store.ports())), ...validateAssignment(devs)] : [];
    if (errs.length) results = [{ deviceId: 0, model: "Settings", address: 0, result: "invalid", ms: null, detail: errs.join("; ") }];
    else if (!merged.enabled) results = devs.map((d) => ({ deviceId: d.id, model: d.model, address: d.modbus_address, result: "off" as const, ms: null, detail: "port is switched off" }));
    else if (!changed) {
      const q = this.queues.get(id); let openErr: unknown = null; if (old.transport === "serial" && q?.tr.openNow) await q.tr.openNow().catch((e) => { openErr = e; });
      for (const d of devs) results.push(await this.probe(d));
      extra = { portOn: true, ...(devs.length ? {} : this.openState(old)) }; void openErr;
    } else results = await this.testDraft(merged, devs, extra);
    const summary = summarize(changed ? "test-draft" : "test-saved", results, extra);
    if (!results.length && extra.openOk === false) results = [{ deviceId: 0, model: merged.transport === "serial" ? merged.device_path : "Port", address: 0, result: "open_error", ms: null, detail: extra.openText }];
    return { port: this.portView(this.store.port(id)!), results, summary, usedDraft: changed, saved: !changed };
  }
  private async testDraft(port: PortRow, devs: DeviceRow[], extra: { openOk?: boolean; openText?: string }): Promise<TestResult[]> {
    if (this.pending) throw new HttpError(409, "a changed setting is waiting to be kept or reverted: press KEEP THESE SETTINGS or REVERT first");
    if (this.busy) throw new HttpError(409, "another change is being applied"); this.busy = true; const results: TestResult[] = [];
    try {
      this.stopPollers(); await this.gw?.pause(); const live = this.queues.get(port.id); await live?.tr.close().catch(() => {});      // release the OS handle: one handle per COM port
      const tr = this.transportFor(port), tq = new PortQueue(tr, { timeoutMs: port.timeout_ms, retries: port.retries, turnaroundMs: port.turnaround_ms });
      try {
        if (port.transport === "serial" && tr.openNow) { try { await tr.openNow(); extra.openOk = true; extra.openText = `${port.device_path} is open`; } catch (e) { extra.openOk = false; extra.openText = e instanceof SerialOpenError ? e.message : String((e as Error)?.message ?? e); } }
        for (const d of devs) results.push(await this.probeOn(d, port, tq, new ModbusMaster(tq, { unit: d.modbus_address, timeoutMs: port.timeout_ms, retries: port.retries })));
      } finally { await tr.close().catch(() => {}); }
    } finally {
      const sp = this.store.port(port.id); if (sp && this.queues.get(port.id)) { const q = this.queues.get(port.id)!; await q.replace(this.transportFor(sp), q.opts); const t = q.tr; if (sp.enabled && sp.transport === "serial" && t.openNow) await Promise.race([t.openNow().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]); }
      this.busy = false; this.startPollers(); this.gw?.resume(); this.emit("update");
    }
    return results;
  }

  // ---------- status ----------
  deviceState(d: DeviceRow): DeviceState {
    const port = this.store.port(d.port_id); if (!d.enabled || !port?.enabled) return "not_connected";
    if (d.kind === "lora_gateway") { if (!this.gw?.drv) return "not_connected"; if (this.gw.online) return "online"; return this.gw.lastOk === null && this.gw.failCycles === 0 ? "unknown" : "offline"; }
    return this.pollers.get(d.id)?.state ?? "unknown";
  }
  portView(p: PortRow, now = Date.now()) {
    const q = this.queues.get(p.id), st = q?.stats; let status: PortStatus = "OPEN"; let lastError = st?.lastError ? errorText(st.lastError, p) : null; const ls = q?.tr.linkState?.();
    if (!p.enabled) { status = "CLOSED"; if (p.transport === "serial" && p.device_path && !serialPathValid(p.device_path)) lastError = PATH_INVALID_HERE + ` (${p.device_path})`; }
    else if (p.transport === "serial" && (!p.device_path || !serialPresent(p.device_path))) { status = "NOT FOUND"; lastError = p.device_path ? errorText(new Error("ENOENT"), p) : "No serial device chosen."; }
    // 2026-11-17: OPEN now means the OS handle exists. Before this, OPEN was printed for every enabled serial port whose name was in the list, whether or not anything had ever been opened.
    else if (p.transport === "serial" && ls?.state === "error") { status = ls.kind === "denied" ? "ACCESS DENIED" : ls.kind === "not_found" ? "NOT FOUND" : "ERROR"; lastError = `${errorText(new Error(ls.error), p)} (OS error: ${ls.error})`; }
    else if (p.transport === "serial" && ls?.state === "closed") { status = "NOT OPEN"; lastError = ls.error ? `The port handle is closed (${ls.error}). CORE reopens it on the next request.` : "The port is not open yet. CORE opens it on the next request."; }
    else if (st?.lastErrorKind === "io" && (st.lastOk === null || st.lastOk < st.lastErrAt!)) status = "ERROR";
    const assigned = this.store.devices().filter((d) => d.port_id === p.id);
    const notPolled = status === "OPEN" && assigned.length > 0 && (st?.requests ?? 0) === 0 && now - (this.builtAt.get(p.id) ?? now) > this.notPolledAfterMs;
    if (notPolled) lastError = "OPEN, but no request has been sent on this port for over a minute although a device is assigned. Check that the device is switched ON in Devices on ports (Enabled) and that its port is this one.";
    return { ...p, status, notPolled, lastError, counters: { requests: st?.requests ?? 0, errors: st?.errors ?? 0, lastOk: st?.lastOk ?? null }, devices: assigned.length, pending: q?.pending() ?? 0 };
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
    return { portId: p.id, portLabel: p.label, enabled: p.enabled && d.enabled, portEnabled: p.enabled, deviceEnabled: d.enabled, transport: p.transport, host: p.tcp_host, port: p.tcp_port, serialPath: p.device_path, baud: p.baud, parity: p.parity, dataBits: p.data_bits, stopBits: p.stop_bits,
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
        return { ok: true, results, pending: null, summary: this.saveSummary(next, results) };
      }
      const t = setTimeout(() => { void this.revert({ username: "system", role: "system" }, undefined, "no confirmation within 30 s").catch(() => {}); }, REVERT_WINDOW_MS); t.unref();
      this.pending = { ports: prevPorts, devices: prevDevices, deadline: Date.now() + REVERT_WINDOW_MS, timer: t };
      audit(this.db, a.username, a.role, "ports.change.unconfirmed", { failed: failed.map((f) => `${f.model}:${f.result}`) });
      return { ok: true, results, pending: { deadline: this.pending.deadline, failed: failed.map((f) => f.model) }, summary: this.saveSummary(next, results) };
    } finally {
      this.busy = false; this.startPollers(); this.gw?.resume(); this.emit("update");        // polling is never left off
    }
  }
  /** The sentence for SAVE: from the real results of the probes just run (and, with no device on the port, from the real state of the OS handle). */
  private saveSummary(next: { ports: PortRow[]; devices: DeviceRow[] }, results: TestResult[]): TestSummary {
    const p = next.ports[0] ? this.store.port(next.ports[0].id) : undefined;
    return summarize("save", results, p ? { portOn: p.enabled, ...this.openState(p) } : undefined);
  }
  private applyRows(next: { ports: PortRow[]; devices: DeviceRow[] }, by: string) { for (const p of next.ports) this.store.savePort(p, by); for (const d of next.devices) this.store.saveDevice(d); }
  private async rebuild(portIds: number[]) { for (const id of portIds) { const p = this.store.port(id); if (p) await this.build(p, true); } await this.bind(); }

  async applyPort(a: Actor, id: number, patch: Record<string, any>) {
    const old = this.store.port(id); if (!old) throw new HttpError(404, "port not found"); const merged = mergePort(old, patch ?? {});
    const errs = [...validatePort(merged), ...validatePorts(this.store.ports().map((p) => (p.id === id ? merged : p)))]; if (errs.length) throw new HttpError(400, errs.join("; "), { errors: errs });
    const diff = (k: keyof PortRow) => old[k] !== merged[k]; const keys = (Object.keys(merged) as (keyof PortRow)[]).filter(diff);
    if (!keys.length) return { ok: true, results: [], pending: null, unchanged: true, summary: { tone: "ok" as const, text: "Nothing changed." } };
    return this.change(a, "ports.update", { ports: [merged], devices: [] }, { port: id, old: Object.fromEntries(keys.map((k) => [k, old[k]])), new: Object.fromEntries(keys.map((k) => [k, merged[k]])) });
  }
  /** Licence limit on gateways (LicenceService, wired in app.ts). Only called when a gateway device is being switched ON. */
  limiter: { checkGatewayAdd(n?: number): void } | null = null;
  /** 2026-11-18 (PLC data source, Modbus RTU): a unit-bound master on the SHARED request queue of port `portId`, so the PLC never talks to the bus at the same time as the sensor gateway. null = no such enabled port. */
  plcMaster(portId: number, unit: number): ModbusMaster | null { const q = this.queues.get(portId); return q ? new ModbusMaster(q, { unit, timeoutMs: q.opts.timeoutMs, retries: q.opts.retries }) : null; }
  async applyDevice(a: Actor, id: number, patch: Record<string, any>) {
    const old = this.store.device(id); if (!old) throw new HttpError(404, "device not found"); const merged = mergeDevice(old, patch ?? {}); const ports = this.store.ports();
    if (merged.kind === "lora_gateway" && merged.enabled && !old.enabled) this.limiter?.checkGatewayAdd(1);
    const errs = [...validateDevice(merged, ports), ...validateAssignment(this.store.devices().map((d) => (d.id === id ? merged : d)))]; if (errs.length) throw new HttpError(400, errs.join("; "), { errors: errs });
    const keys = (Object.keys(merged) as (keyof DeviceRow)[]).filter((k) => old[k] !== merged[k]); if (!keys.length) return { ok: true, results: [], pending: null, unchanged: true, summary: { tone: "ok" as const, text: "Nothing changed." } };
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
      return { ok: true, results, summary: summarize("revert", results, { portOn: ports[0]?.enabled }) };
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
    // Lab bundle (2026-11-17): COM names are STORED as bare COMn ("\\.\COM12" and "com12" become "COM12"), also when they arrive in a backup. Nothing is ever auto-mapped: a foreign path keeps its text.
    for (const p of ports) if (p && p.transport === "serial" && typeof p.device_path === "string") { const c = isWin(platform) ? canonicalSerialPath(p.device_path, platform) : null; if (c) p.device_path = c; }
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
