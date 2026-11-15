// Modbus master with ONE request queue. Writes jump ahead of polls (the same bus may later also carry control commands).
import { MAX_READ_REGS, ModbusException, ModbusTimeout, parseResponse, readPdu, write1Pdu, writeNPdu } from "./frames.js";
import type { ModbusTransport } from "./transport.js";

export type Priority = "write" | "poll";
export interface MasterOptions { unit: number; timeoutMs: number; retries: number; }
interface Job { prio: Priority; pdu: Buffer; resolve: (r: number[]) => void; reject: (e: unknown) => void; }

export class ModbusMaster {
  private q: { write: Job[]; poll: Job[] } = { write: [], poll: [] }; private running = false;
  constructor(private tr: ModbusTransport, public opts: MasterOptions) {}
  setUnit(unit: number) { this.opts.unit = unit; }
  private submit(prio: Priority, pdu: Buffer): Promise<number[]> {
    return new Promise((resolve, reject) => { this.q[prio].push({ prio, pdu, resolve, reject }); void this.pump(); });
  }
  private async pump() {
    if (this.running) return; this.running = true;
    try {
      for (;;) {
        const j = this.q.write.shift() ?? this.q.poll.shift(); if (!j) break;
        try { j.resolve(await this.exec(j.pdu)); } catch (e) { j.reject(e); }
      }
    } finally { this.running = false; }
  }
  private async exec(pdu: Buffer): Promise<number[]> {
    let last: unknown;
    for (let a = 0; a <= this.opts.retries; a++) {
      try { return parseResponse(pdu, await this.tr.request(this.opts.unit, pdu, this.opts.timeoutMs)); }
      catch (e) { last = e; if (e instanceof ModbusException) throw e; /* a device exception is an answer, never retried */ }
    }
    throw last;
  }
  pending() { return this.q.write.length + this.q.poll.length; }

  /** Read any number of registers, split into requests of at most 125. */
  async read(fc: 3 | 4, addr: number, count: number, prio: Priority = "poll"): Promise<number[]> {
    const out: number[] = [];
    for (let off = 0; off < count; off += MAX_READ_REGS) out.push(...(await this.submit(prio, readPdu(fc, addr + off, Math.min(MAX_READ_REGS, count - off)))));
    return out;
  }
  write1(addr: number, val: number, prio: Priority = "write") { return this.submit(prio, write1Pdu(addr, val)).then(() => undefined); }
  writeN(addr: number, vals: number[], prio: Priority = "write") { return this.submit(prio, writeNPdu(addr, vals)).then(() => undefined); }
  close() { return this.tr.close(); }
}
export { ModbusException, ModbusTimeout };
