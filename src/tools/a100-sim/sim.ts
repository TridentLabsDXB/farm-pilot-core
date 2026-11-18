// 2026-11-18 -- fake Ashining A100 for the bench and the tests: a TCP server that answers register reads and writes in the operating-mode frame and swallows every other byte (data frames for the radio).
// It follows the SAME frame rules as src/a100/frames.ts, so a bench pass proves CORE against itself, not against a real unit (the VERIFY marks in frames.ts / registers.ts still need the real module).
// Never started by default: `npm run a100-sim` (port 5503). It never sends anything over any radio.
import { createServer, type Server, type Socket } from "node:net";
import { DEFAULT_ID, parseOpFrame } from "../../a100/frames.js";
import { REG, REG_LEN } from "../../a100/registers.js";

export class A100Sim {
  regs = new Map<number, Buffer>();
  /** Data frames received (bytes the unit would send over the air). */
  swallowed: Buffer[] = [];
  reads: number[] = []; writes: { reg: number; data: Buffer }[] = [];
  /** Test switches: answer nothing / refuse writes of these registers / lose the last write's effect. */
  silent = false; refuse = new Set<number>(); corruptWrite = new Set<number>();
  constructor(private id: Buffer = DEFAULT_ID) {
    const set = (r: number, b: Buffer | number[]) => this.regs.set(r, Buffer.from(b));
    set(REG.VERSION, Buffer.concat([Buffer.from("A100-L400M30-v1.2.00", "ascii")])); set(REG.RSSI, [0, 95, 0, 80]);
    const baud = Buffer.alloc(4); baud.writeUInt32BE(9600); set(REG.BAUD, baud); set(REG.FORMAT, [0x00]); set(REG.RADIO, [0x02, 0xfc]); set(REG.MODE, [0x00, 0x02]); set(REG.ACK, [0x85]); set(REG.RETRY_MS, [0x03, 0xe8]); set(REG.ROLE, [0]);
    set(REG.KEY, Buffer.from("www.ashining.com", "ascii")); set(REG.PACKET_LEN, [64]); set(REG.PACK_TIME, [35]); set(REG.WAKE, [0, 0]); set(REG.OPTIONS, [0, 0]); set(REG.LOCAL_GROUP, [1]); set(REG.LOCAL_ADDR, [1]); set(REG.DEST_GROUP, [1]); set(REG.DEST_ADDR, [2]);
  }
  /** One chunk in, zero or more reply frames out. */
  handle(buf: Buffer): { reply: Buffer[]; rest: Buffer } {
    const out: Buffer[] = []; let b = buf;
    for (;;) {
      const i = b.indexOf(Buffer.from([0xaf, 0xaf]));
      if (i < 0) { if (b.length) this.swallowed.push(b); return { reply: out, rest: Buffer.alloc(0) }; }
      if (i > 0) { this.swallowed.push(b.subarray(0, i)); b = b.subarray(i); }
      const f = parseOpFrame(b, this.id); if (f === null) return { reply: out, rest: b }; if (f === "bad") { this.swallowed.push(b); return { reply: out, rest: Buffer.alloc(0) }; }
      const n = 9 + (f.write ? f.len : 0) + 11; b = b.subarray(n);
      if (this.silent) continue;
      if (!f.write) { this.reads.push(f.start); const v = this.regs.get(f.start); out.push(v ? this.readReply(f.start, v) : this.errReply(f.start, f.len, false)); continue; }
      if (this.refuse.has(f.start) || (f.start !== REG.REBOOT && f.start !== REG.FACTORY && !REG_LEN[f.start])) { out.push(this.errReply(f.start, f.len, true)); continue; }
      this.writes.push({ reg: f.start, data: f.data }); if (f.start !== REG.REBOOT && f.start !== REG.FACTORY) this.regs.set(f.start, this.corruptWrite.has(f.start) ? Buffer.alloc(f.data.length, 0xee) : Buffer.from(f.data));
      out.push(this.writeReply(f.start, f.len));
    }
  }
  // A reply is the same frame shape: a read reply carries the data (cmd 0x00 with data is not expressible by buildOpFrame, so it is assembled here); a write reply echoes the command without data.
  private readReply(reg: number, v: Buffer) { return this.assemble(0x00, reg, v.length, v); }
  private writeReply(reg: number, len: number) { return this.assemble(0x80, reg, len, Buffer.alloc(0)); }
  private errReply(reg: number, len: number, write: boolean) { return this.assemble(write ? 0xc0 : 0x40, reg, len, Buffer.alloc(0)); }
  private assemble(cmd: number, start: number, len: number, data: Buffer) {
    const head = Buffer.concat([Buffer.from([0xaf, 0xaf]), this.id, Buffer.from([0x5a, (~cmd) & 0xff, cmd, start, len]), data]); let s = 0, x = 0; for (const v of head) { s = (s + v) & 0xff; x ^= v; }
    return Buffer.concat([head, Buffer.from([s, x, 0x50, 0x50]), Buffer.from([...this.id].map((v) => (~v) & 0xff)), Buffer.from([0xa5, 0x0d, 0x0a])]);
  }
}

export function serveA100(sim: A100Sim, port: number): Server {
  const srv = createServer((s: Socket) => { let acc: Buffer = Buffer.alloc(0); s.on("error", () => {}); s.on("data", (d: Buffer) => { const r = sim.handle(Buffer.concat([acc, d])); acc = r.rest; for (const f of r.reply) s.write(f); }); });
  srv.listen(port, "127.0.0.1"); return srv;
}
