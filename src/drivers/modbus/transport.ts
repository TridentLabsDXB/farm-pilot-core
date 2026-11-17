// ModbusTransport: one request/response exchange at a time. Implementations: Modbus TCP (MBAP), RTU over TCP (RS485-to-Ethernet converter or the bench
// simulator's RTU port) and RTU over a serial port (production: RS485 / USB-RS485 on the industrial PC, 9600 8N1 by default).
import { Socket } from "node:net";
import { mbapLength, mbapWrap, ModbusTimeout, rtuFrameLength, rtuUnwrap, rtuWrap } from "./frames.js";
import { modbusTrace, serialError, serialInfo } from "../../serialLog.js";

export interface ModbusTransport {
  /** Send a request PDU to a unit and resolve with the response PDU (function code first). */
  request(unit: number, pdu: Buffer, timeoutMs: number): Promise<Buffer>;
  close(): Promise<void>;
  /** Frames received that were garbage or failed the CRC check (RTU). Lets TEST PORT tell "CRC ERROR" from "NO ANSWER". */
  badFrames?(): number;
  /** Serial only: really open the port now (so a wrong COM name or a busy port shows at once, not on the first request). Rejects with SerialOpenError. */
  openNow?(): Promise<void>;
  /** Serial only: the state of the OS handle. "open" is true only while a handle exists; "error" carries the OS text of the last failed open. */
  linkState?(): LinkState | undefined;
}
export interface LinkState { state: "closed" | "open" | "error"; kind?: "denied" | "not_found" | "busy" | "other"; error?: string; since: number; }
/** The OS refused to open the serial port. message = "could not open COM11: <OS text>". */
export class SerialOpenError extends Error {
  constructor(public path: string, public osMessage: string, public kind: "denied" | "not_found" | "busy" | "other", public code?: string) { super(`could not open ${path}: ${osMessage}`); this.name = "SerialOpenError"; }
}
const kindOf = (msg: string, code?: string): "denied" | "not_found" | "busy" | "other" =>
  /access (is )?denied|EACCES|EPERM|permission denied/i.test(msg) || code === "EACCES" ? "denied" : /file not found|cannot find|ENOENT|no such file/i.test(msg) || code === "ENOENT" ? "not_found" : /EBUSY|resource busy|in use/i.test(msg) ? "busy" : "other";

/** The serialport module. A function so tests can plug in a fake serial line (setSerialModuleForTests); the optional dependency is only loaded when a serial port is really used. */
let serialLoader: () => Promise<any> = () => import("serialport");
export const loadSerial = () => serialLoader();
export const setSerialModuleForTests = (m: any | null) => { serialLoader = m ? async () => m : () => import("serialport"); };
export interface TransportConfig {
  type: "tcp" | "rtu-tcp" | "rtu-serial";
  host?: string; port?: number;                                  // tcp, rtu-tcp
  path?: string; baud?: number; parity?: "none" | "even" | "odd"; dataBits?: 7 | 8; stopBits?: 1 | 2;   // rtu-serial
}

interface Channel { write(b: Buffer): Promise<void>; onData(cb: (b: Buffer) => void): void; close(): Promise<void>; openNow?(): Promise<void>; linkState?(): LinkState | undefined; }

class TcpChannel implements Channel {
  private sock?: Socket; private cb: (b: Buffer) => void = () => {}; private connecting?: Promise<Socket>;
  constructor(private host: string, private port: number) {}
  private connect(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    return (this.connecting ??= new Promise<Socket>((res, rej) => {
      const s = new Socket(); s.setNoDelay(true);
      const fail = (e: Error) => { this.connecting = undefined; s.destroy(); rej(e); };
      s.setTimeout(3000, () => fail(new ModbusTimeout("connect timeout")));
      s.once("error", fail);
      s.connect(this.port, this.host, () => { s.setTimeout(0); s.removeListener("error", fail); s.on("error", () => s.destroy()); s.on("close", () => { if (this.sock === s) this.sock = undefined; });
        s.on("data", (d: Buffer) => this.cb(d)); this.sock = s; this.connecting = undefined; res(s); });
    }));
  }
  async write(b: Buffer) { const s = await this.connect(); await new Promise<void>((r, j) => s.write(b, (e) => (e ? j(e) : r()))); }
  onData(cb: (b: Buffer) => void) { this.cb = cb; }
  async close() { this.sock?.destroy(); this.sock = undefined; }
}

class SerialChannel implements Channel {
  private port: any; private cb: (b: Buffer) => void = () => {}; private opening?: Promise<any>; private st: LinkState = { state: "closed", since: Date.now() };
  constructor(private cfg: TransportConfig) {}
  linkState(): LinkState | undefined { return { ...this.st }; }
  openNow() { return this.open().then(() => {}); }
  private fail(path: string, e: unknown): SerialOpenError {
    const os = String((e as Error)?.message ?? e), code = (e as any)?.code as string | undefined, err = new SerialOpenError(path, os, kindOf(os, code), code);
    this.st = { state: "error", kind: err.kind, error: os, since: Date.now() }; serialError(`${err.message}${code ? ` (${code})` : ""}`); return err;
  }
  private open(): Promise<any> {
    if (this.port?.isOpen) return Promise.resolve(this.port);
    return (this.opening ??= this.doOpen().finally(() => { this.opening = undefined; }));
  }
  private async doOpen() {
    const path = this.cfg.path!, baud = this.cfg.baud ?? 9600, par = this.cfg.parity ?? "none", bits = this.cfg.dataBits ?? 8, stop = this.cfg.stopBits ?? 1;
    let mod: any; try { mod = await loadSerial(); } catch (e) { throw this.fail(path, new Error("the serialport module could not be loaded: " + String((e as Error)?.message ?? e))); }
    // serialport prepends \\.\ itself on Windows (bindings-cpp serialport_win.cpp), so the bare name COM11 is opened as \\.\COM11; handing it \\.\COM11 would double the prefix.
    const osPath = process.platform === "win32" && /^COM\d+$/i.test(path) ? "\\\\.\\" + path : path;
    serialInfo(`opening ${path} (OS path ${osPath}) ${baud} ${bits}${par === "none" ? "N" : par === "even" ? "E" : "O"}${stop}`);
    const port = new mod.SerialPort({ path, baudRate: baud, parity: par, dataBits: bits, stopBits: stop, autoOpen: false });
    try { await new Promise<void>((r, j) => port.open((e: Error | null) => (e ? j(e) : r()))); } catch (e) { throw this.fail(path, e); }
    port.on("data", (d: Buffer) => { modbusTrace("RX", path, d); this.cb(d); });
    port.on("error", (e: Error) => serialError(`${path}: ${e?.message ?? e}`));
    port.on("close", (e?: Error) => { if (this.port === port) { this.port = undefined; this.st = { state: "closed", since: Date.now(), error: e ? String(e.message ?? e) : "the port was closed (adapter unplugged?)" }; serialInfo(`${path} closed by the system${e ? ": " + e.message : ""}; it is reopened on the next request`); } });
    this.port = port; this.st = { state: "open", since: Date.now() }; serialInfo(`opened ${path}`);
    return port;
  }
  async write(b: Buffer) { const p = await this.open(); modbusTrace("TX", this.cfg.path!, b); await new Promise<void>((r, j) => p.write(b, (e: Error | null) => (e ? j(e) : p.drain((e2: Error | null) => (e2 ? j(e2) : r()))))); }
  onData(cb: (b: Buffer) => void) { this.cb = cb; }
  async close() {
    const p = this.port; this.port = undefined; if (!p?.isOpen) return;
    this.st = { state: "closed", since: Date.now() }; serialInfo(`closing ${this.cfg.path}`); await new Promise<void>((r) => p.close(() => r()));
  }
}

class Exchange {
  private pending?: { match: (b: Buffer) => Buffer | null | "bad"; resolve: (p: Buffer) => void; timer: NodeJS.Timeout };
  bad = 0; badFrames() { return this.bad; }
  private buf = Buffer.alloc(0); private chain: Promise<unknown> = Promise.resolve();
  constructor(protected ch: Channel) { ch.onData((d) => this.feed(d)); }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 4096) this.buf = Buffer.alloc(0);
    const p = this.pending; if (!p) { this.buf = Buffer.alloc(0); return; }
    const r = p.match(this.buf); if (r === null) return;
    this.buf = Buffer.alloc(0); if (r === "bad") { this.bad++; return; }     // garbage or CRC error: keep waiting until timeout
    clearTimeout(p.timer); this.pending = undefined; p.resolve(r);
  }
  protected exchange(frame: Buffer, match: (b: Buffer) => Buffer | null | "bad", timeoutMs: number): Promise<Buffer> {
    const run = () => new Promise<Buffer>((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const timer = setTimeout(() => { this.pending = undefined; reject(new ModbusTimeout()); }, timeoutMs);
      this.pending = { match, resolve, timer };
      this.ch.write(frame).catch((e) => { clearTimeout(timer); this.pending = undefined; reject(e); });
    });
    const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next;
  }
  close() { return this.ch.close(); }
  openNow() { return this.ch.openNow ? this.ch.openNow() : Promise.resolve(); }
  linkState() { return this.ch.linkState?.(); }
}

class RtuTransport extends Exchange implements ModbusTransport {
  request(unit: number, pdu: Buffer, timeoutMs: number) {
    return this.exchange(rtuWrap(unit, pdu), (b) => {
      const n = rtuFrameLength(b, "res"); if (n < 0) return "bad"; if (n === 0 || b.length < n) return null;
      const f = rtuUnwrap(b.subarray(0, n)); return !f || f.unit !== unit || (f.pdu[0] & 0x7f) !== (pdu[0] & 0x7f) ? "bad" : Buffer.from(f.pdu);
    }, timeoutMs);
  }
}
class MbapTransport extends Exchange implements ModbusTransport {
  private tid = 0;
  request(unit: number, pdu: Buffer, timeoutMs: number) {
    const tid = (this.tid = (this.tid + 1) & 0xffff);
    return this.exchange(mbapWrap(tid, unit, pdu), (b) => {
      const n = mbapLength(b); if (n === 0 || b.length < n) return null;
      return b.readUInt16BE(0) !== tid || b[6] !== unit ? "bad" : Buffer.from(b.subarray(7, n));
    }, timeoutMs);
  }
}

export function createTransport(c: TransportConfig): ModbusTransport {
  if (c.type === "tcp") return new MbapTransport(new TcpChannel(c.host!, c.port ?? 502));
  if (c.type === "rtu-tcp") return new RtuTransport(new TcpChannel(c.host!, c.port ?? 502));
  if (c.type === "rtu-serial") { if (!c.path) throw new Error("serial path required"); return new RtuTransport(new SerialChannel(c)); }
  throw new Error("unknown transport " + (c as any).type);
}
