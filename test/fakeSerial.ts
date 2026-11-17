// A fake serialport module for tests (2026-11-17, Windows lab). It behaves like the real thing where it matters for the lab bug:
//   * ONE handle per COM port: opening a port that is already open fails with "Opening COM11: Access denied" (what Windows does when the vendor tool holds it),
//   * open errors can be scripted per path, requests are answered by a slave function (unit, pdu) -> response pdu, with modes silent / garbage / bad CRC,
//   * every opened path, every closed path and every TX frame is recorded, so a test can prove what was opened and when.
import { EventEmitter } from "node:events";
import { rtuFrameLength, rtuUnwrap, rtuWrap } from "../src/drivers/modbus/frames.js";

export class FakeLine {
  openError = new Map<string, { message: string; code?: string }>(); present = ["COM11"]; held = new Set<string>();
  opened: string[] = []; closed: string[] = []; tx: Buffer[] = []; chunks: number[] = []; mode: "ok" | "silent" | "garbage" | "badcrc" = "ok";
  /** Deliver a reply in n bursts with random gaps (ms), like a USB-RS485 adapter. corrupt: flip one byte in the first N replies. truncate: cut this many bytes off the end of the first N replies (0 = never). stray: bytes sent before every reply. */
  burst: { n: number; gapMin: number; gapMax: number } | null = null; corrupt = 0; truncate = { times: 0, cut: 0 }; stray: number[] = [];
  slave: (unit: number, pdu: Buffer) => Buffer | null = () => null;
  listInfos: Record<string, unknown>[] | null = null;
  module: any;
  constructor() {
    const line = this;
    class FakePort extends EventEmitter {
      isOpen = false; path: string; opts: any;
      constructor(opts: any) { super(); this.opts = opts; this.path = opts.path; }
      open(cb: (e: Error | null) => void) {
        setImmediate(() => {
          const scripted = line.openError.get(this.path); if (scripted) return cb(Object.assign(new Error(scripted.message), { code: scripted.code }));
          if (line.held.has(this.path)) return cb(new Error(`Opening ${this.path}: Access denied`));
          line.held.add(this.path); line.opened.push(this.path); this.isOpen = true; cb(null);
        });
      }
      write(b: Buffer, cb: (e: Error | null) => void) {
        line.tx.push(Buffer.from(b)); cb(null);
        const req = rtuUnwrap(b); if (!req || line.mode === "silent") return;
        const res = line.slave(req.unit, req.pdu); if (!res) return;
        const frame = rtuWrap(req.unit, res); if (line.mode === "badcrc") frame[frame.length - 1] ^= 0xff;
        let out = frame;
        if (line.corrupt > 0 && line.mode === "ok") { line.corrupt--; out = Buffer.from(frame); out[Math.floor(out.length / 2)] ^= 0xb8; }
        if (line.truncate.times > 0) { line.truncate.times--; out = out.subarray(0, out.length - line.truncate.cut); }
        if (line.stray.length) out = Buffer.concat([Buffer.from(line.stray), out]);
        if (line.burst && line.mode === "ok") {
          const { n, gapMin, gapMax } = line.burst, size = Math.ceil(out.length / n); let at = 0, t = 0;
          for (let k = 0; k < n && at < out.length; k++, at += size) { const part = out.subarray(at, at + size); t += k === 0 ? 5 : gapMin + Math.random() * (gapMax - gapMin); setTimeout(() => { if (this.isOpen) { line.chunks.push(part.length); this.emit("data", Buffer.from(part)); } }, t); }
          return;
        }
        setImmediate(() => { if (!this.isOpen) return; if (line.mode === "garbage") this.emit("data", Buffer.from([0xde, 0xad, 0xbe])); else this.emit("data", out); });
      }
      drain(cb: (e: Error | null) => void) { cb(null); }
      close(cb: () => void) { if (this.isOpen) { this.isOpen = false; line.held.delete(this.path); line.closed.push(this.path); } setImmediate(() => { this.emit("close"); cb(); }); }
      /** Pull the plug: the OS closes the handle. */
      unplug() { this.isOpen = false; line.held.delete(this.path); this.emit("close", new Error("device removed")); }
      static async list() { return line.listInfos ?? line.present.map((path) => ({ path, friendlyName: `USB-SERIAL CH340 (${path})`, vendorId: "1A86", productId: "7523" })); }
    }
    this.module = { SerialPort: FakePort }; void rtuFrameLength;
  }
}
/** Run fn with process.platform pretending to be win32 (the lab case), then restore it. */
export async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  const d = Object.getOwnPropertyDescriptor(process, "platform")!; Object.defineProperty(process, "platform", { value: "win32" });
  try { return await fn(); } finally { Object.defineProperty(process, "platform", d); }
}
/** Collect console.log / console.error while fn runs. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; log: string[]; err: string[] }> {
  const log: string[] = [], err: string[] = []; const ol = console.log, oe = console.error; console.log = (...a: unknown[]) => { log.push(a.join(" ")); }; console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  try { return { result: await fn(), log, err }; } finally { console.log = ol; console.error = oe; }
}
