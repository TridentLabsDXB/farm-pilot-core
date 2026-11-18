// 2026-11-18 -- Ashining A100-L400M30 (RS-485 to LoRa data transceiver): parameter protocol frames. Pure functions, no I/O.
// Source: manual Spec_A100-L400M30_V4.3, checked in core-control-devices-a100-manual-verification.md (2026-11-18). CONFIRMED by the manual: write command code 0x80, read 0x00, remote bit 0x40,
// answers (write ok `80 REG LEN`, failed `C0 REG LEN`, read `00 REG LEN` + data), LEN = number of REGISTERS (not bytes), the data of a write = the sum of the byte lengths of the registers written,
// multi-byte values big-endian, command code inverted sent before the command code. Still VERIFY on a real unit: (1) whether the operating-mode frame is accepted in target transmission or master-slave mode with auto-answer on (assumed yes); (2) the reboot / restore answer address (0x20/0x21 in the register table, 0x22/0x23 in the manual's examples: both are accepted); (3) the error-flag bit of an operating-mode answer (0x40 or 0x20, see parseOpFrame).
import { regBytes } from "./registers.js";

/** Operating-mode command frame (valid while the module works normally; it is the ONLY frame family CORE uses to read and write the unit):
 *  AF AF | ID(2) | 5A | ~CMD | CMD | START | LEN | DATA... | SUM | XOR | 50 50 | ~ID(2) | A5 | 0D 0A
 *  check: SUM = low byte of the sum of every byte from the first AF through the last DATA byte, XOR = XOR of the same bytes. Verified against the manual example (read all parameters,
 *  `AF AF 55 55 5A FF 00 04 1C 81 BD 50 50 AA AA A5 0D 0A`) in test/a100.test.ts. */
export const DEFAULT_ID = Buffer.from([0x55, 0x55]);
export type A100Cmd = { write: boolean; start: number; /** number of REGISTERS */ len: number; data?: Buffer };

const inv = (b: Buffer) => Buffer.from([...b].map((x) => (~x) & 0xff));
export function checkBytes(b: Buffer): [number, number] { let s = 0, x = 0; for (const v of b) { s = (s + v) & 0xff; x ^= v; } return [s, x]; }

export function buildOpFrame(c: A100Cmd, id: Buffer = DEFAULT_ID): Buffer {
  if (id.length !== 2) throw new Error("ID code must be 2 bytes");
  const data = c.write ? c.data ?? Buffer.alloc(0) : Buffer.alloc(0);
  if (c.start < 0 || c.start > 0xff || c.len < 0 || c.len > 0xff) throw new Error("start and length must be one byte");
  const need = regBytes(c.start, c.len); if (c.write && need !== null && data.length !== need) throw new Error(`data length must equal the byte length of the registers written (${need}), got ${data.length}`);
  const cmd = c.write ? 0x80 : 0x00;
  const head = Buffer.concat([Buffer.from([0xaf, 0xaf]), id, Buffer.from([0x5a, (~cmd) & 0xff, cmd, c.start, c.len]), data]);
  const [s, x] = checkBytes(head);
  return Buffer.concat([head, Buffer.from([s, x, 0x50, 0x50]), inv(id), Buffer.from([0xa5, 0x0d, 0x0a])]);
}

/** One operating-mode frame, request or answer. The length of the data is found from the frame itself (the first terminator whose check bytes agree), never from LEN, because LEN counts registers.
 *  The caller compares data.length with the register map and rejects a wrong length (A100 reply of the wrong size). null = not complete yet; "bad" = complete but invalid.
 *  `error`: the answer carries the failure flag (the manual's failure answer is 0xC0; bit5 0x20 is also named as the error flag, so either 0x40 or 0x20 counts; requests never set them here). */
export interface OpFrame { cmd: number; write: boolean; error: boolean; start: number; len: number; data: Buffer }
export function parseOpFrame(b: Buffer, id: Buffer = DEFAULT_ID): OpFrame | null | "bad" {
  const i = b.indexOf(Buffer.from([0xaf, 0xaf])); if (i < 0) return b.length >= 2 ? "bad" : null;
  const f = b.subarray(i); if (f.length < 9) return null;
  if (!f.subarray(2, 4).equals(id) || f[4] !== 0x5a || ((~f[5]) & 0xff) !== f[6]) return "bad";
  const tail = Buffer.concat([Buffer.from([0x50, 0x50]), inv(id), Buffer.from([0xa5, 0x0d, 0x0a])]); let from = 11, sawTail = false;
  for (;;) {
    const t = f.indexOf(tail, from); if (t < 0) break; sawTail = true;                      // t = index of the first 0x50
    const body = f.subarray(0, t - 2), [s, x] = checkBytes(body);
    if (t - 2 >= 9 && f[t - 2] === s && f[t - 1] === x) return { cmd: f[6], write: (f[6] & 0x80) !== 0, error: (f[6] & 0x60) !== 0, start: f[7], len: f[8], data: Buffer.from(f.subarray(9, t - 2)) };
    from = t + 1;                                                                           // a data byte that looks like the terminator: keep looking
  }
  return sawTail ? "bad" : f.length > 600 ? "bad" : null;
}

/** Configuration-mode command (RESET lamp lit, serial fixed at 9600 8N1): CMD REG LEN DATA. NOT used by CORE (the page uses operating-mode frames only, so no physical access is needed); kept as the
 *  documented manual path and for tests. CMD bit7 = write, bit6 = remote; answers `80 REG LEN` ok / `C0 REG LEN` failed. LEN = number of registers. */
export function buildCfgFrame(c: { write: boolean; reg: number; len: number; data?: Buffer; remote?: boolean }): Buffer {
  const data = c.write ? c.data ?? Buffer.alloc(0) : Buffer.alloc(0); const need = regBytes(c.reg, c.len);
  if (c.write && need !== null && data.length !== need) throw new Error(`data length must equal the byte length of the registers written (${need}), got ${data.length}`);
  return Buffer.concat([Buffer.from([(c.write ? 0x80 : 0) | (c.remote ? 0x40 : 0), c.reg, c.len]), data]);
}
export interface CfgAnswer { ok: boolean; write: boolean; reg: number; len: number; data: Buffer }
/** null = more bytes needed. A read answer is `00 REG LEN` + the bytes of those registers (from the register map), a write answer echoes CMD REG LEN only. */
export function parseCfgAnswer(b: Buffer, wantReg: number): CfgAnswer | null {
  if (b.length < 3) return null; const cmd = b[0], write = (cmd & 0x80) !== 0, bad = (cmd & 0x40) !== 0 && write, reg = b[1], len = b[2];
  if (reg !== wantReg) return null;
  if (write) return { ok: !bad, write: true, reg, len, data: Buffer.alloc(0) };
  const n = regBytes(reg, len) ?? 0; if (b.length < 3 + n) return null; return { ok: true, write: false, reg, len, data: Buffer.from(b.subarray(3, 3 + n)) };
}

/** Target transmission mode: the first 3 bytes of every outgoing frame are the destination address high, address low and channel (core-control-devices spec, DEVICES BEHIND THIS LINK). */
export function targetPrefix(addrHigh: number, addrLow: number, channel: number): Buffer {
  for (const v of [addrHigh, addrLow, channel]) if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error("address and channel must be 0 to 255");
  return Buffer.from([addrHigh, addrLow, channel]);
}

/** Answer delays from the manual: the next command must wait at least this long after the previous one. */
export const DELAY_MS = { write: 100, read: 40, version: 100, reset: 40 } as const;
