// ModbusTransport: one request/response exchange at a time. Implementations: Modbus TCP (MBAP), RTU over TCP (RS485-to-Ethernet converter or the bench
// simulator's RTU port) and RTU over a serial port (production: RS485 / USB-RS485 on the industrial PC, 9600 8N1 by default).
import { Socket } from "node:net";
import { mbapLength, mbapWrap, ModbusTimeout, rtuFrameLength, rtuUnwrap, rtuWrap } from "./frames.js";

export interface ModbusTransport {
  /** Send a request PDU to a unit and resolve with the response PDU (function code first). */
  request(unit: number, pdu: Buffer, timeoutMs: number): Promise<Buffer>;
  close(): Promise<void>;
  /** Frames received that were garbage or failed the CRC check (RTU). Lets TEST PORT tell "CRC ERROR" from "NO ANSWER". */
  badFrames?(): number;
}
export interface TransportConfig {
  type: "tcp" | "rtu-tcp" | "rtu-serial";
  host?: string; port?: number;                                  // tcp, rtu-tcp
  path?: string; baud?: number; parity?: "none" | "even" | "odd"; dataBits?: 7 | 8; stopBits?: 1 | 2;   // rtu-serial
}

interface Channel { write(b: Buffer): Promise<void>; onData(cb: (b: Buffer) => void): void; close(): Promise<void>; }

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
  private port: any; private cb: (b: Buffer) => void = () => {};
  constructor(private cfg: TransportConfig) {}
  private async open() {
    if (this.port?.isOpen) return this.port;
    // serialport is an optional dependency: only the real-hardware path needs it, the bench never loads it.
    const { SerialPort } = await import("serialport");
    this.port = new SerialPort({ path: this.cfg.path!, baudRate: this.cfg.baud ?? 9600, parity: this.cfg.parity ?? "none", dataBits: this.cfg.dataBits ?? 8, stopBits: this.cfg.stopBits ?? 1, autoOpen: false });
    await new Promise<void>((r, j) => this.port.open((e: Error | null) => (e ? j(e) : r())));
    this.port.on("data", (d: Buffer) => this.cb(d)); this.port.on("error", () => {});
    return this.port;
  }
  async write(b: Buffer) { const p = await this.open(); await new Promise<void>((r, j) => p.write(b, (e: Error | null) => (e ? j(e) : p.drain((e2: Error | null) => (e2 ? j(e2) : r()))))); }
  onData(cb: (b: Buffer) => void) { this.cb = cb; }
  async close() { const p = this.port; if (p?.isOpen) await new Promise<void>((r) => p.close(() => r())); }
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
