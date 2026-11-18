// 2026-11-18 -- fake Ashining A100 for the bench and the tests: a TCP server that answers register reads and writes in the operating-mode frame and swallows every other byte (data frames for the radio).
// It follows the manual as recorded in core-control-devices-a100-manual-verification.md: LEN counts registers, data bytes = register byte lengths, write answer `80 REG LEN`, failure `C0 REG LEN`, read answer
// `00 REG LEN` + data. A bench pass still proves CORE against this reading, not against a real unit (the VERIFY marks in frames.ts / registers.ts need the real module).
// Never started by default: `npm run a100-sim` (port 5503). It never sends anything over any radio.
import { createServer, type Server, type Socket } from "node:net";
import { DEFAULT_ID, parseOpFrame } from "../../a100/frames.js";
import { REG, REG_LEN, regBytes } from "../../a100/registers.js";

export class A100Sim {
  regs = new Map<number, Buffer>();
  /** Data frames received (bytes the unit would send over the air). */
  swallowed: Buffer[] = [];
  reads: number[] = []; writes: { reg: number; data: Buffer }[] = [];
  /** Test switches: answer nothing / refuse writes of these registers / lose the last write's effect. */
  silent = false; refuse = new Set<number>(); corruptWrite = new Set<number>();
  /** Quirks the manual allows: register 0x17 answered with 1 byte (factory table); a read answer one byte too long (the manual's sample dumps have a stray byte); reset echoed at 0x22 / 0x23 instead of 0x20 / 0x21. */
  opt1Byte = false; longRead = new Set<number>(); echoPlus2 = false;
  constructor(private id: Buffer = DEFAULT_ID) {
    const set = (r: number, b: Buffer | number[]) => this.regs.set(r, Buffer.from(b));
    set(REG.VERSION, Buffer.concat([Buffer.from("A100-L400M30-v1.2.00", "ascii")])); set(REG.RSSI, [0, 95, 0, 80]);
    const baud = Buffer.alloc(4); baud.writeUInt32BE(9600); set(REG.BAUD, baud); set(REG.FORMAT, [0x00]); set(REG.RADIO, [0x02, 0xfa]); set(REG.MODE, [0x00, 0x02]); set(REG.ACK, [0x85]); set(REG.RETRY_MS, [0x03, 0xe8]); set(REG.ROLE, [0]);
    set(REG.KEY, Buffer.from("www.ashining.com", "ascii")); set(REG.PACKET_LEN, [64]); set(REG.PACK_TIME, [0, 35]); set(REG.WAKE, [0]); set(0x0c, [0, 0, 0, 0, 0]); set(0x0d, [0]); set(0x16, [0]); set(REG.OPTIONS, [0, 0]); set(REG.LOCAL_GROUP, [1]); set(REG.LOCAL_ADDR, [1]); set(REG.DEST_GROUP, [1]); set(REG.DEST_ADDR, [2]);
  }
  /** One chunk in, zero or more reply frames out. */
  handle(buf: Buffer): { reply: Buffer[]; rest: Buffer } {
    const out: Buffer[] = []; let b = buf;
    for (;;) {
      const i = b.indexOf(Buffer.from([0xaf, 0xaf]));
      if (i < 0) { if (b.length) this.swallowed.push(b); return { reply: out, rest: Buffer.alloc(0) }; }
      if (i > 0) { this.swallowed.push(b.subarray(0, i)); b = b.subarray(i); }
      const f = parseOpFrame(b, this.id); if (f === null) return { reply: out, rest: b }; if (f === "bad") { this.swallowed.push(b); return { reply: out, rest: Buffer.alloc(0) }; }
      b = b.subarray(18 + f.data.length);
      if (this.silent) continue;
      const echo = (reg: number) => (this.echoPlus2 && (reg === REG.REBOOT || reg === REG.FACTORY) ? reg + 2 : reg);
      if (!f.write) {
        this.reads.push(f.start); const parts: Buffer[] = []; for (let r = f.start; r < f.start + f.len; r++) { const v = this.regs.get(r); if (!v) break; parts.push(r === REG.OPTIONS && this.opt1Byte ? v.subarray(1) : this.longRead.has(r) ? Buffer.concat([v, Buffer.from([0x77])]) : v); }
        out.push(parts.length === f.len ? this.assemble(0x00, f.start, f.len, Buffer.concat(parts)) : this.assemble(0x40, f.start, f.len, Buffer.alloc(0))); continue;
      }
      const isCmd = f.start === REG.REBOOT || f.start === REG.FACTORY;
      if (this.refuse.has(f.start) || (!isCmd && !REG_LEN[f.start]) || (!isCmd && regBytes(f.start, f.len) !== f.data.length)) { out.push(this.assemble(0xc0, f.start, f.len, Buffer.alloc(0))); continue; }
      this.writes.push({ reg: f.start, data: f.data });
      if (!isCmd) { let o = 0; for (let r = f.start; r < f.start + f.len; r++) { const n = REG_LEN[r]; this.regs.set(r, this.corruptWrite.has(r) ? Buffer.alloc(n, 0xee) : Buffer.from(f.data.subarray(o, o + n))); o += n; } }
      out.push(this.assemble(0x80, echo(f.start), f.len, Buffer.alloc(0)));
    }
  }
  // Answers are assembled here (a read answer carries data under cmd 0x00, which buildOpFrame does not build); a write answer echoes the command without data.
  private assemble(cmd: number, start: number, len: number, data: Buffer) {
    const head = Buffer.concat([Buffer.from([0xaf, 0xaf]), this.id, Buffer.from([0x5a, (~cmd) & 0xff, cmd, start, len]), data]); let s = 0, x = 0; for (const v of head) { s = (s + v) & 0xff; x ^= v; }
    return Buffer.concat([head, Buffer.from([s, x, 0x50, 0x50]), Buffer.from([...this.id].map((v) => (~v) & 0xff)), Buffer.from([0xa5, 0x0d, 0x0a])]);
  }
}

export function serveA100(sim: A100Sim, port: number): Server {
  const srv = createServer((s: Socket) => { let acc: Buffer = Buffer.alloc(0); s.on("error", () => {}); s.on("data", (d: Buffer) => { const r = sim.handle(Buffer.concat([acc, d])); acc = r.rest; for (const f of r.reply) s.write(f); }); });
  srv.listen(port, "127.0.0.1"); return srv;
}
