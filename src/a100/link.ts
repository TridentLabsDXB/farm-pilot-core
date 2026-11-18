// 2026-11-18 -- A100 link driver: parameter reads and writes, and data frames for the devices behind the link, over ONE serial port that holds the A100 alone.
// Everything goes through one promise chain, so two operations never overlap on the line, and each waits the manual's answer delay (write ~100 ms, read 40 ms, version 100 ms) after the previous one.
// The transport is the port's own (PortManager.queueOf(port).tr), so this never touches another port's queue. NO command frame for a fan is built here: see TODO(fan-payload) in service.ts.
import { ModbusTimeout } from "../drivers/modbus/frames.js";
import type { ModbusTransport } from "../drivers/modbus/transport.js";
import { buildCfgFrame, buildOpFrame, DEFAULT_ID, DELAY_MS, parseCfgAnswer, parseOpFrame } from "./frames.js";
import { decodeAck, decodeBaud, decodeFormat, decodeOptions, decodeRadio, decodeRssi, isFactoryKey, modeName, REG, REG_LEN } from "./registers.js";

export class A100Error extends Error { constructor(public kind: "no_link" | "no_answer" | "refused" | "bad_frame" | "unsupported", msg: string) { super(msg); this.name = "A100Error"; } }
export interface LinkOpts { idCode?: Buffer; timeoutMs?: number; /** "operating" (default): the AF AF command frame while the module runs. "configuration": CMD REG LEN at 9600 8N1 (RESET lamp lit). */ mode?: "operating" | "configuration"; sleep?: (ms: number) => Promise<void>; }

export interface UnitParams {
  version: string | null; rssi: { envDbm: number; packetDbm: number } | null;
  baud: number | null; format: ReturnType<typeof decodeFormat> | null; radio: ReturnType<typeof decodeRadio> | null;
  mode: { value: number; name: string } | null; ack: ReturnType<typeof decodeAck> | null; retryMs: number | null;
  packetLen: number | null; packTimeMs: number | null; options: ReturnType<typeof decodeOptions> | null; optionsRaw: number | null;
  local: { group: number; address: number } | null; dest: { group: number; address: number } | null;
  /** true / false after a read of register 0x0B. The key itself is dropped inside readParams and never leaves this module. null = could not be read. */
  defaultKey: boolean | null;
  /** Registers that did not answer (named), so a partial answer is never shown as complete. */
  missing: string[];
  /** Raw register bytes as hex, by register number (the key register is never included). Used to put the old values back (REVERT) and to merge partial changes. */
  raw: Record<number, string>;
}

export class A100Link {
  private chain: Promise<unknown> = Promise.resolve(); private notBefore = 0;
  private id: Buffer; private timeoutMs: number; private mode: "operating" | "configuration"; private sleep: (ms: number) => Promise<void>;
  /** Frames written to the line, for tests ("TEST LINK sends no command frame"). Registers are listed by number only, never with data. */
  readonly sent: { at: number; kind: "read" | "write" | "data"; reg?: number; bytes: number }[] = [];
  constructor(private tr: () => ModbusTransport | null, o: LinkOpts = {}) { this.id = o.idCode ?? DEFAULT_ID; this.timeoutMs = o.timeoutMs ?? 1500; this.mode = o.mode ?? "operating"; this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); }

  private serial<T>(fn: () => Promise<T>): Promise<T> { const run = () => fn(); const next = this.chain.then(run, run); this.chain = next.catch(() => {}); return next; }
  private line() { const t = this.tr(); if (!t?.rawExchange || !t.rawSend) throw new A100Error("no_link", "the port is not open or does not carry raw bytes"); return t as ModbusTransport & Required<Pick<ModbusTransport, "rawExchange" | "rawSend">>; }
  private async wait() { const d = this.notBefore - Date.now(); if (d > 0) await this.sleep(d); }

  private regLen(reg: number) { const n = REG_LEN[reg]; if (!n) throw new A100Error("unsupported", `register 0x${reg.toString(16)} is not in the register map`); return n; }

  readReg(reg: number): Promise<Buffer> {
    return this.serial(async () => {
      const t = this.line(), len = this.regLen(reg); await this.wait();
      const frame = this.mode === "operating" ? buildOpFrame({ write: false, start: reg, len }, this.id) : buildCfgFrame({ write: false, reg, len });
      this.sent.push({ at: Date.now(), kind: "read", reg, bytes: frame.length });
      try {
        if (this.mode === "operating") {
          const got = await t.rawExchange(frame, (b) => { const f = parseOpFrame(b, this.id); return f && f !== "bad" && !f.write && f.start === reg && f.data.length === len ? b : null; }, this.timeoutMs);
          const f = parseOpFrame(got, this.id); if (!f || f === "bad") throw new A100Error("bad_frame", "unreadable answer"); if (f.error) throw new A100Error("refused", `the unit refused the read of register 0x${reg.toString(16)}`); return f.data;
        }
        const got = await t.rawExchange(frame, (b) => (parseCfgAnswer(b, reg) ? b : null), this.timeoutMs); const a = parseCfgAnswer(got, reg)!; if (!a.ok) throw new A100Error("refused", "the unit refused the read"); return a.data;
      } catch (e) { throw e instanceof ModbusTimeout ? new A100Error("no_answer", "the A100 did not answer: " + e.message) : e; }
      finally { this.notBefore = Date.now() + (reg === REG.VERSION ? DELAY_MS.version : DELAY_MS.read); }
    });
  }

  writeReg(reg: number, data: Buffer): Promise<void> {
    return this.serial(async () => {
      const t = this.line(), len = this.regLen(reg); if (data.length !== len) throw new A100Error("unsupported", `register 0x${reg.toString(16)} takes ${len} bytes`); await this.wait();
      const frame = this.mode === "operating" ? buildOpFrame({ write: true, start: reg, len, data }, this.id) : buildCfgFrame({ write: true, reg, len, data });
      this.sent.push({ at: Date.now(), kind: "write", reg, bytes: frame.length });
      try {
        if (this.mode === "operating") {
          const got = await t.rawExchange(frame, (b) => { const f = parseOpFrame(b, this.id); return f && f !== "bad" && f.start === reg ? b : null; }, this.timeoutMs);
          const f = parseOpFrame(got, this.id); if (!f || f === "bad") throw new A100Error("bad_frame", "unreadable answer"); if (f.error) throw new A100Error("refused", `the unit refused the write of register 0x${reg.toString(16)} (value out of range or not allowed)`);
        } else {
          const got = await t.rawExchange(frame, (b) => (parseCfgAnswer(b, reg) ? b : null), this.timeoutMs); if (!parseCfgAnswer(got, reg)!.ok) throw new A100Error("refused", "the unit refused the write: it keeps the old value");
        }
      } catch (e) { throw e instanceof ModbusTimeout ? new A100Error("no_answer", "the A100 did not answer: " + e.message) : e; }
      finally { this.notBefore = Date.now() + DELAY_MS.write; }
    });
  }

  /** Reboot (0x20) or restore factory settings (0x21): the caller has already obtained its own confirmation. A reboot answers nothing useful, so no answer is not an error. */
  command(reg: 0x20 | 0x21): Promise<void> {
    return this.serial(async () => {
      const t = this.line(); await this.wait(); const frame = this.mode === "operating" ? buildOpFrame({ write: true, start: reg, len: 1, data: Buffer.from([0x01]) }, this.id) : buildCfgFrame({ write: true, reg, len: 1, data: Buffer.from([0x01]) });
      this.sent.push({ at: Date.now(), kind: "write", reg, bytes: frame.length }); await t.rawSend(frame); this.notBefore = Date.now() + DELAY_MS.reset;
    });
  }

  /** A data frame for a device behind the link (already wrapped by the caller: in target transmission mode with the 3-byte prefix). Resolves when the bytes are written: that is SENT, nothing more. */
  sendData(frame: Buffer): Promise<void> {
    return this.serial(async () => { const t = this.line(); await this.wait(); this.sent.push({ at: Date.now(), kind: "data", bytes: frame.length }); await t.rawSend(frame); });
  }

  async readVersion(): Promise<string> { return (await this.readReg(REG.VERSION)).toString("ascii").replace(/\0+$/g, "").trim(); }
  async readRssi() { return decodeRssi(await this.readReg(REG.RSSI)); }

  /** READ FROM UNIT. A register that does not answer is named in `missing`; no answer at all (version) throws. */
  async readParams(): Promise<UnitParams> {
    const version = await this.readVersion(), missing: string[] = [], raw: Record<number, string> = {};
    const get = async <T>(name: string, reg: number, f: (b: Buffer) => T): Promise<T | null> => { try { const b = await this.readReg(reg); if (reg !== REG.KEY) raw[reg] = b.toString("hex"); return f(b); } catch (e) { if (e instanceof A100Error && e.kind === "no_link") throw e; missing.push(name); return null; } };
    const u16 = (b: Buffer) => b.readUInt16BE(0), u8 = (b: Buffer) => b[0];
    const mode = await get("mode", REG.MODE, (b) => ({ value: u16(b), name: modeName(u16(b)) })), optionsRaw = await get("options", REG.OPTIONS, u16);
    const lg = await get("local group", REG.LOCAL_GROUP, u8), la = await get("local address", REG.LOCAL_ADDR, u8), dg = await get("destination group", REG.DEST_GROUP, u8), da = await get("destination address", REG.DEST_ADDR, u8);
    const key = await get("key", REG.KEY, (b) => isFactoryKey(b));       // the Buffer is dropped inside the callback; only the yes/no leaves
    return { version, rssi: await get("signal", REG.RSSI, decodeRssi), baud: await get("baud", REG.BAUD, decodeBaud), format: await get("serial format", REG.FORMAT, (b) => decodeFormat(u8(b))),
      radio: await get("radio", REG.RADIO, (b) => decodeRadio(u16(b))), mode, ack: await get("radio ack", REG.ACK, (b) => decodeAck(u8(b))), retryMs: await get("retry interval", REG.RETRY_MS, u16),
      packetLen: await get("packet length", REG.PACKET_LEN, u8), packTimeMs: await get("packing time", REG.PACK_TIME, (b) => u8(b) / 10), options: optionsRaw === null ? null : decodeOptions(optionsRaw), optionsRaw,
      local: lg === null || la === null ? null : { group: lg, address: la }, dest: dg === null || da === null ? null : { group: dg, address: da }, defaultKey: key, missing, raw };
  }
}
