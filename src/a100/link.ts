// 2026-11-18 -- A100 link driver: parameter reads and writes, and data frames for the devices behind the link, over ONE serial port that holds the A100 alone.
// Everything goes through one promise chain, so two operations never overlap on the line, and each waits the manual's answer delay (write ~100 ms, read 40 ms, version 100 ms) after the previous one.
// READ, WRITE and TEST LINK use operating-mode frames ONLY (no physical access needed); configuration mode stays a manual path (frames.ts). Every single-register command has LEN = 1 (registers), the data is REG_LEN bytes.
// The transport is the port's own (PortManager.queueOf(port).tr), so this never touches another port's queue. NO command frame for a fan is built here: see TODO(fan-payload) in service.ts.
import { ModbusTimeout } from "../drivers/modbus/frames.js";
import type { ModbusTransport } from "../drivers/modbus/transport.js";
import { buildOpFrame, DEFAULT_ID, DELAY_MS, parseOpFrame } from "./frames.js";
import { decodeAck, decodeBaud, decodeFormat, decodeOptions, decodeRadio, decodeRssi, isFactoryKey, lengthsOf, modeName, REG, REG_LEN } from "./registers.js";

export class A100Error extends Error { constructor(public kind: "no_link" | "no_answer" | "refused" | "bad_frame" | "unsupported", msg: string) { super(msg); this.name = "A100Error"; } }
export interface LinkOpts { idCode?: Buffer; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; }

export interface UnitParams {
  version: string | null; /** The unit's RAW numbers (manual: "convert to decimal"); no unit, no sign, no dBm. */ rssi: { env: number; packet: number } | null;
  baud: number | null; format: ReturnType<typeof decodeFormat> | null; radio: ReturnType<typeof decodeRadio> | null;
  mode: { value: number; name: string } | null; ack: ReturnType<typeof decodeAck> | null; retryMs: number | null;
  packetLen: number | null; packTimeMs: number | null; options: ReturnType<typeof decodeOptions> | null; optionsRaw: number | null;
  local: { group: number; address: number } | null; dest: { group: number; address: number } | null;
  /** true / false after a read of register 0x0B. The key itself is dropped inside readParams and never leaves this module. null = could not be read. */
  defaultKey: boolean | null;
  /** Registers that did not answer (named), so a partial answer is never shown as complete. */
  missing: string[];
  /** Raw register bytes as hex, by register number (the key register is never included). Used to put the old values back (REVERT) and to merge partial changes. Register 0x17 is always 2 bytes here. */
  raw: Record<number, string>;
}

export class A100Link {
  private chain: Promise<unknown> = Promise.resolve(); private notBefore = 0;
  private id: Buffer; private timeoutMs: number; private sleep: (ms: number) => Promise<void>;
  /** Frames written to the line, for tests ("TEST LINK sends no command frame"). Registers are listed by number only, never with data. */
  readonly sent: { at: number; kind: "read" | "write" | "data"; reg?: number; bytes: number }[] = [];
  constructor(private tr: () => ModbusTransport | null, o: LinkOpts = {}) { this.id = o.idCode ?? DEFAULT_ID; this.timeoutMs = o.timeoutMs ?? 1500; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); }

  private serial<T>(fn: () => Promise<T>): Promise<T> { const run = () => fn(); const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next; }
  private line() { const t = this.tr(); if (!t?.rawExchange || !t.rawSend) throw new A100Error("no_link", "the port is not open or does not carry raw bytes"); return t as ModbusTransport & Required<Pick<ModbusTransport, "rawExchange" | "rawSend">>; }
  private async wait() { const d = this.notBefore - Date.now(); if (d > 0) await this.sleep(d); }
  private known(reg: number) { if (!REG_LEN[reg]) throw new A100Error("unsupported", `register 0x${reg.toString(16)} is not in the register map`); return REG_LEN[reg]; }

  /** One register, operating-mode frame, LEN = 1. The answer is parsed by the register map: a data length that is not the register's length (or 0x17's other length) is rejected, never half-used. */
  readReg(reg: number): Promise<Buffer> {
    return this.serial(async () => {
      const t = this.line(); this.known(reg); await this.wait();
      const frame = buildOpFrame({ write: false, start: reg, len: 1 }, this.id); this.sent.push({ at: Date.now(), kind: "read", reg, bytes: frame.length });
      try {
        const got = await t.rawExchange(frame, (b) => { const f = parseOpFrame(b, this.id); return f === "bad" || (f && !f.write && f.start === reg) || (f && f.error && f.start === reg) ? b : null; }, this.timeoutMs);
        const f = parseOpFrame(got, this.id); if (!f || f === "bad") throw new A100Error("bad_frame", "unreadable answer from the A100");
        if (f.error) throw new A100Error("refused", `the unit refused the read of register 0x${reg.toString(16)}`);
        if (!lengthsOf(reg).includes(f.data.length)) throw new A100Error("bad_frame", `the answer for register 0x${reg.toString(16)} has ${f.data.length} bytes, the register map says ${lengthsOf(reg).join(" or ")}: rejected`);
        return reg === REG.OPTIONS && f.data.length === 1 ? Buffer.concat([Buffer.from([0]), f.data]) : f.data;       // 0x17 is 1 byte in the factory table: normalised to 2 bytes
      } catch (e) { throw e instanceof ModbusTimeout ? new A100Error("no_answer", "the A100 did not answer: " + e.message) : e; }
      finally { this.notBefore = Date.now() + (reg === REG.VERSION ? DELAY_MS.version : DELAY_MS.read); }
    });
  }

  /** One register, LEN = 1, the data is the register's byte length (0x17: 2 bytes). The answer is `80 REG LEN` (saved) or `C0 REG LEN` (refused, old value kept). */
  writeReg(reg: number, data: Buffer): Promise<void> {
    return this.serial(async () => {
      const t = this.line(), n = this.known(reg); if (data.length !== n) throw new A100Error("unsupported", `register 0x${reg.toString(16)} takes ${n} bytes`); await this.wait();
      const frame = buildOpFrame({ write: true, start: reg, len: 1, data }, this.id); this.sent.push({ at: Date.now(), kind: "write", reg, bytes: frame.length });
      try {
        const got = await t.rawExchange(frame, (b) => { const f = parseOpFrame(b, this.id); return f === "bad" || (f && f.start === reg) ? b : null; }, this.timeoutMs);
        const f = parseOpFrame(got, this.id); if (!f || f === "bad") throw new A100Error("bad_frame", "unreadable answer from the A100");
        if (f.error) throw new A100Error("refused", `the unit refused the write of register 0x${reg.toString(16)}: it keeps the old value (value out of range or not allowed)`);
        if (f.data.length !== 0) throw new A100Error("bad_frame", "a write answer should only echo the command: rejected");
      } catch (e) { throw e instanceof ModbusTimeout ? new A100Error("no_answer", "the A100 did not answer: " + e.message) : e; }
      finally { this.notBefore = Date.now() + DELAY_MS.write; }
    });
  }

  /** Reboot (0x20) or restore factory settings (0x21). DISABLED in the service until verified on a real unit with nothing else on the link. The answer echoes the register as 0x20/0x21 (register table) or
   *  0x22/0x23 (the manual's examples): either is accepted. A reboot may answer nothing, so no answer is not an error. */
  command(reg: 0x20 | 0x21): Promise<{ answered: boolean; echo: number | null }> {
    return this.serial(async () => {
      const t = this.line(); await this.wait(); const frame = buildOpFrame({ write: true, start: reg, len: 1, data: Buffer.from([0x01]) }, this.id); this.sent.push({ at: Date.now(), kind: "write", reg, bytes: frame.length });
      try {
        const got = await t.rawExchange(frame, (b) => { const f = parseOpFrame(b, this.id); return f === "bad" || (f && (f.start === reg || f.start === reg + 2)) ? b : null; }, this.timeoutMs);
        const f = parseOpFrame(got, this.id); this.notBefore = Date.now() + DELAY_MS.reset; if (!f || f === "bad") return { answered: true, echo: null };
        if (f.error) throw new A100Error("refused", "the unit refused the command"); return { answered: true, echo: f.start };
      } catch (e) { this.notBefore = Date.now() + DELAY_MS.reset; if (e instanceof ModbusTimeout) return { answered: false, echo: null }; throw e; }
    });
  }

  /** A data frame for a device behind the link (already wrapped by the caller: in target transmission mode with the 3-byte prefix). Resolves when the bytes are written: that is SENT, nothing more. */
  sendData(frame: Buffer): Promise<void> {
    return this.serial(async () => { const t = this.line(); await this.wait(); this.sent.push({ at: Date.now(), kind: "data", bytes: frame.length }); await t.rawSend(frame); });
  }

  async readVersion(): Promise<string> { return (await this.readReg(REG.VERSION)).toString("ascii").replace(/\0+$/g, "").trim(); }
  async readRssi() { return decodeRssi(await this.readReg(REG.RSSI)); }

  /** READ FROM UNIT: every register of the map one by one (LEN = 1). A register that does not answer or answers with a wrong length is named in `missing`; no answer at all (version) throws. */
  async readParams(): Promise<UnitParams> {
    const version = await this.readVersion(), missing: string[] = [], raw: Record<number, string> = {};
    const get = async <T>(name: string, reg: number, f: (b: Buffer) => T): Promise<T | null> => { try { const b = await this.readReg(reg); if (reg !== REG.KEY) raw[reg] = b.toString("hex"); return f(b); } catch (e) { if (e instanceof A100Error && e.kind === "no_link") throw e; missing.push(name); return null; } };
    const u16 = (b: Buffer) => b.readUInt16BE(0), u8 = (b: Buffer) => b[0];
    const mode = await get("mode", REG.MODE, (b) => ({ value: u16(b), name: modeName(u16(b)) })), optionsRaw = await get("options", REG.OPTIONS, u16);
    const lg = await get("local group", REG.LOCAL_GROUP, u8), la = await get("local address", REG.LOCAL_ADDR, u8), dg = await get("destination group", REG.DEST_GROUP, u8), da = await get("destination address", REG.DEST_ADDR, u8);
    const key = await get("key", REG.KEY, (b) => isFactoryKey(b));       // the Buffer is dropped inside the callback; only the yes/no leaves
    return { version, rssi: await get("signal", REG.RSSI, decodeRssi), baud: await get("baud", REG.BAUD, decodeBaud), format: await get("serial format", REG.FORMAT, (b) => decodeFormat(u8(b))),
      radio: await get("radio", REG.RADIO, (b) => decodeRadio(u16(b))), mode, ack: await get("radio ack", REG.ACK, (b) => decodeAck(u8(b))), retryMs: await get("retry interval", REG.RETRY_MS, u16),
      packetLen: await get("packet length", REG.PACKET_LEN, u8), packTimeMs: await get("packing time", REG.PACK_TIME, (b) => u16(b) / 10), options: optionsRaw === null ? null : decodeOptions(optionsRaw), optionsRaw,
      local: lg === null || la === null ? null : { group: lg, address: la }, dest: dg === null || da === null ? null : { group: dg, address: da }, defaultKey: key, missing, raw };
  }
}
