// Modbus master. One PortQueue per RS-485 port: strictly ONE request at a time on that port, writes jump ahead of polls, every device on the port shares the queue.
// A ModbusMaster is a thin, unit-bound handle onto a queue (one per device). Two ports = two independent queues, so a hung device on one never delays the other.
import { MAX_READ_REGS, ModbusException, ModbusTimeout, parseResponse, readPdu, write1Pdu, writeNPdu } from "./frames.js";
import type { ModbusTransport } from "./transport.js";

export type Priority = "write" | "poll";
export interface MasterOptions { unit: number; timeoutMs: number; retries: number; turnaroundMs?: number; }
export interface QueueOptions { timeoutMs: number; retries: number; turnaroundMs: number; }
interface Job { prio: Priority; unit: number; pdu: Buffer; resolve: (r: number[]) => void; reject: (e: unknown) => void; }
export interface QueueStats { requests: number; errors: number; lastOk: number | null; lastError: string | null; lastErrorKind: "timeout" | "exception" | "io" | null; lastErrAt: number | null; }

export class PortQueue {
  private q: { write: Job[]; poll: Job[] } = { write: [], poll: [] }; private running = false;
  stats: QueueStats = { requests: 0, errors: 0, lastOk: null, lastError: null, lastErrorKind: null, lastErrAt: null };
  constructor(public tr: ModbusTransport, public opts: QueueOptions) {}
  /** Swap the transport (new line settings). The old one is closed; jobs already queued run on the new one. */
  async replace(tr: ModbusTransport, opts: QueueOptions) { const old = this.tr; this.tr = tr; this.opts = opts; await old.close().catch(() => {}); }
  submit(unit: number, prio: Priority, pdu: Buffer): Promise<number[]> {
    return new Promise((resolve, reject) => { this.q[prio].push({ prio, unit, pdu, resolve, reject }); void this.pump(); });
  }
  pending() { return this.q.write.length + this.q.poll.length; }
  private async pump() {
    if (this.running) return; this.running = true;
    try {
      for (;;) {
        const j = this.q.write.shift() ?? this.q.poll.shift(); if (!j) break;
        try { j.resolve(await this.exec(j)); } catch (e) { j.reject(e); }
        if (this.opts.turnaroundMs > 0) await new Promise((r) => setTimeout(r, this.opts.turnaroundMs));
      }
    } finally { this.running = false; }
  }
  private async exec(j: Job): Promise<number[]> {
    let last: unknown;
    for (let a = 0; a <= this.opts.retries; a++) {
      this.stats.requests++;
      try { const r = parseResponse(j.pdu, await this.tr.request(j.unit, j.pdu, this.opts.timeoutMs)); this.stats.lastOk = Date.now(); return r; }
      catch (e) {
        last = e; const isEx = e instanceof ModbusException;
        if (isEx) this.stats.lastOk = Date.now();                                  // an exception reply is still an answer: the device is alive
        else { this.stats.errors++; this.stats.lastErrAt = Date.now(); this.stats.lastError = String((e as Error)?.message ?? e); this.stats.lastErrorKind = e instanceof ModbusTimeout ? "timeout" : "io"; }
        if (isEx) throw e;                                                           // a device exception is an answer, never retried
      }
    }
    // 2026-11-17: say WHICH request failed (function, address, count) next to the real reason, e.g. "short reply: got 7 of 11 bytes within 1500 ms (FC04 addr 0x0000 count 1)".
    if (last instanceof Error && !last.message.includes(" (FC")) last.message += ` (FC${String(j.pdu[0]).padStart(2, "0")} addr 0x${j.pdu.readUInt16BE(1).toString(16).padStart(4, "0")} count ${j.pdu.readUInt16BE(3)})`;
    throw last;
  }
}

export class ModbusMaster {
  private pq: PortQueue;
  /** Pass a transport (own private queue, used by tests and tools) or a shared PortQueue (the runtime: one per port). */
  constructor(src: ModbusTransport | PortQueue, public opts: MasterOptions) {
    this.pq = src instanceof PortQueue ? src : new PortQueue(src, { timeoutMs: opts.timeoutMs, retries: opts.retries, turnaroundMs: opts.turnaroundMs ?? 0 });
  }
  get queue() { return this.pq; }
  setUnit(unit: number) { this.opts.unit = unit; }
  private submit(prio: Priority, pdu: Buffer) { return this.pq.submit(this.opts.unit, prio, pdu); }
  pending() { return this.pq.pending(); }

  /** Read any number of registers, split into requests of at most 125. */
  async read(fc: 3 | 4, addr: number, count: number, prio: Priority = "poll"): Promise<number[]> {
    const out: number[] = [];
    for (let off = 0; off < count; off += MAX_READ_REGS) out.push(...(await this.submit(prio, readPdu(fc, addr + off, Math.min(MAX_READ_REGS, count - off)))));
    return out;
  }
  write1(addr: number, val: number, prio: Priority = "write") { return this.submit(prio, write1Pdu(addr, val)).then(() => undefined); }
  writeN(addr: number, vals: number[], prio: Priority = "write") { return this.submit(prio, writeNPdu(addr, vals)).then(() => undefined); }
  close() { return this.pq.tr.close(); }
}
export { ModbusException, ModbusTimeout };
