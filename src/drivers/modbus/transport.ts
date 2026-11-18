// ModbusTransport: one request/response exchange at a time. Implementations: Modbus TCP (MBAP), RTU over TCP (RS485-to-Ethernet converter or the bench
// simulator's RTU port) and RTU over a serial port (production: RS485 / USB-RS485 on the industrial PC, 9600 8N1 by default).
import { Socket } from "node:net";
import { crc16, mbapLength, mbapWrap, ModbusBadFrame, ModbusTimeout, rtuExpectedResponse, rtuWrap } from "./frames.js";
import { modbusNote, modbusTrace, serialError, serialInfo } from "../../serialLog.js";

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

/** What a matcher says about the bytes received so far: null = need more, "bad" = junk, drop it and keep waiting (TCP stale reply), {fail} = a whole reply arrived but is unusable, give up on this attempt now so the queue retries at once. */
type Match = Buffer | null | "bad" | { fail: string };
class Exchange {
  private pending?: { match: (b: Buffer) => Match; resolve: (p: Buffer) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };
  bad = 0; badFrames() { return this.bad; }
  private buf = Buffer.alloc(0); private chain: Promise<unknown> = Promise.resolve();
  constructor(protected ch: Channel) { ch.onData((d) => this.feed(d)); }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 4096) this.buf = Buffer.alloc(0);
    const p = this.pending; if (!p) { this.buf = Buffer.alloc(0); return; }
    const r = p.match(this.buf); if (r === null) return;
    if (r === "bad") { this.buf = Buffer.alloc(0); this.bad++; return; }          // junk: keep waiting until timeout
    clearTimeout(p.timer); this.pending = undefined;
    if (Buffer.isBuffer(r)) { this.buf = Buffer.alloc(0); p.resolve(r); return; }
    this.bad++; this.buf = Buffer.alloc(0); p.reject(new ModbusBadFrame(r.fail));
  }
  /** describe(bytesSoFar): the reason text when the timeout expires ("no reply" vs "short reply: got N of M bytes"). */
  protected exchange(frame: Buffer, match: (b: Buffer) => Match, timeoutMs: number, describe?: (got: Buffer) => string): Promise<Buffer> {
    const run = () => new Promise<Buffer>((resolve, reject) => {
      this.buf = Buffer.alloc(0);
      const timer = setTimeout(() => { this.pending = undefined; const got = this.buf; this.buf = Buffer.alloc(0); reject(new ModbusTimeout(describe ? describe(got) : "modbus timeout")); }, timeoutMs);
      this.pending = { match, resolve, reject, timer };
      this.ch.write(frame).catch((e) => { clearTimeout(timer); this.pending = undefined; reject(e); });
    });
    const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next;
  }
  close() { return this.ch.close(); }
  openNow() { return this.ch.openNow ? this.ch.openNow() : Promise.resolve(); }
  linkState() { return this.ch.linkState?.(); }
}

/** A USB-RS485 adapter hands a long reply over in bursts (the lab saw 8 bursts with 20-60 ms gaps for 245 bytes), so silence between bytes never ends a frame here. */
export function matchRtuResponse(b: Buffer, unit: number, pdu: Buffer): Match {
  const fc = pdu[0], total = rtuExpectedResponse(pdu), isRead = fc >= 1 && fc <= 4, count = isRead ? (fc <= 2 ? Math.ceil(pdu.readUInt16BE(3) / 8) : pdu.readUInt16BE(3) * 2) : 0;   // count = expected byte count of the reply (bits: ceil(n/8), registers: 2n)
  let crcBad = false, waiting = false;
  for (let i = 0; i < b.length; i++) {                                           // stray bytes before the frame are skipped: a candidate starts at <unit><fc or fc|0x80>
    if (b[i] !== unit) continue;
    if (i + 1 >= b.length) { waiting = true; continue; }
    const f = b[i + 1], isEx = f === (fc | 0x80); if (f !== fc && !isEx) continue;
    if (!isEx && isRead && i + 2 < b.length && b[i + 2] !== count) continue; // byte count disagrees with the request: not our reply
    const n = isEx ? 5 : total; if (n === null) continue;
    if (b.length - i < n) { waiting = true; continue; }                          // known length not reached yet: keep reading until it is (or the timeout)
    const fr = b.subarray(i, i + n);
    if (crc16(fr.subarray(0, n - 2)) !== fr.readUInt16LE(n - 2)) { crcBad = true; continue; }   // a frame that fails its CRC is never accepted
    return Buffer.from(fr.subarray(1, n - 2));
  }
  return crcBad && !waiting ? { fail: `bad CRC (${b.length} bytes received${total ? `, ${total} expected` : ""})` } : null;
}
class RtuTransport extends Exchange implements ModbusTransport {
  request(unit: number, pdu: Buffer, timeoutMs: number) {
    const total = rtuExpectedResponse(pdu), t0 = Date.now(), tmo = timeoutMs;
    return this.exchange(rtuWrap(unit, pdu), (b) => {
      const r = matchRtuResponse(b, unit, pdu);
      if (Buffer.isBuffer(r)) modbusNote(`frame ok unit ${unit} fc ${pdu[0]} ${b.length}B in ${Date.now() - t0} ms`); else if (r && typeof r === "object") modbusNote(`frame rejected: ${r.fail}`);
      return r;
    }, tmo, (got) => {
      const m = got.length === 0 ? `timeout: no reply within ${tmo} ms` : `short reply: got ${got.length} of ${total ?? "?"} bytes within ${tmo} ms`; modbusNote(m); return m;
    });
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
