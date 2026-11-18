// PLC bench simulator: a small Modbus TCP (MBAP) server with a few moving registers, for testing the PLC data source without hardware. NOT started by CORE and not enabled by default.
//   node dist/tools/plc-sim/main.js        (PLC_SIM_PORT 5502, PLC_SIM_BIND 127.0.0.1)
// Layout (SAMPLE values, not real PLC addresses): holding 0..19 = counters and sine waves, input 0..9, coils 0..15 and discrete 0..15 toggle. Anything above address 199 answers exception 02.
// It is READ ONLY like CORE: every write function code is answered with exception 01 (illegal function), so a bench run also proves CORE sends none.
import { createServer, type Server } from "node:net";
export type SimMode = "ok" | "silent" | "exception" | "garbage";
export class PlcSim {
  holding = new Array<number>(200).fill(0); input = new Array<number>(200).fill(0); coils = new Array<number>(200).fill(0); discrete = new Array<number>(200).fill(0);
  mode: SimMode = "ok"; exceptionCode = 2; seen: number[] = [];       // seen = every function code received (tests assert no write code)
  private t = 0; server: Server | null = null;
  tick() {
    this.t++; this.holding[0] = this.t & 0xffff; this.holding[1] = Math.round(500 + 100 * Math.sin(this.t / 10));
    const f = Buffer.alloc(4); f.writeFloatBE(21.5 + 3 * Math.sin(this.t / 20)); this.holding[2] = f.readUInt16BE(0); this.holding[3] = f.readUInt16BE(2);
    this.input[0] = 100 + (this.t % 50); for (let i = 0; i < 16; i++) { this.coils[i] = (this.t >> (i % 4)) & 1; this.discrete[i] = i % 2 ? 1 : (this.t & 1); }
  }
  /** One request PDU -> one response PDU (or null = stay silent). */
  respond(pdu: Buffer): Buffer | null {
    const fc = pdu[0]; this.seen.push(fc);
    if (this.mode === "silent") return null; if (this.mode === "garbage") return Buffer.from([0xff]);
    const ex = (c: number) => Buffer.from([fc | 0x80, c]);
    if (this.mode === "exception") return ex(this.exceptionCode);
    if (fc < 1 || fc > 4) return ex(1);
    if (pdu.length < 5) return ex(3);
    const addr = pdu.readUInt16BE(1), n = pdu.readUInt16BE(3), mem = fc === 1 ? this.coils : fc === 2 ? this.discrete : fc === 3 ? this.holding : this.input;
    if (n < 1 || n > (fc <= 2 ? 2000 : 125)) return ex(3); if (addr + n > mem.length) return ex(2);
    if (fc <= 2) { const b = Buffer.alloc(2 + Math.ceil(n / 8)); b[0] = fc; b[1] = b.length - 2; for (let i = 0; i < n; i++) if (mem[addr + i]) b[2 + (i >> 3)] |= 1 << (i & 7); return b; }
    const b = Buffer.alloc(2 + n * 2); b[0] = fc; b[1] = n * 2; for (let i = 0; i < n; i++) b.writeUInt16BE(mem[addr + i] & 0xffff, 2 + i * 2); return b;
  }
  listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on("error", () => s.destroy());
      s.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
          const len = 6 + buf.readUInt16BE(4), f = buf.subarray(0, len); buf = buf.subarray(len);
          const r = this.respond(f.subarray(7)); if (!r) continue;
          const h = Buffer.alloc(7); f.copy(h, 0, 0, 7); h.writeUInt16BE(r.length + 1, 4); s.write(Buffer.concat([h, r]));
        }
      });
    });
    return new Promise((res) => this.server!.listen(port, host, () => res((this.server!.address() as any).port)));
  }
  close() { return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
}
