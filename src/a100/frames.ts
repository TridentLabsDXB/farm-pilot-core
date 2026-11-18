// 2026-11-18 -- Ashining A100-L400M30 (RS-485 to LoRa data transceiver): parameter protocol frames. Pure functions, no I/O.
// Source: manual Spec_A100-L400M30_V4.3 as summarised in core-control-devices-ashining-a100-page.md. The manual PDF itself was NOT available to the build, so every rule below that is not
// in that summary is marked VERIFY and must be confirmed on the real unit (the fake A100 in src/tools/a100-sim follows the same rules, so a bench pass proves self-consistency only).

/** Operating-mode command frame (valid while the module works normally):
 *  AF AF | ID(2) | 5A | ~CMD | CMD | START | LEN | DATA... | SUM | XOR | 50 50 | ~ID(2) | A5 | 0D 0A
 *  check: SUM = low byte of the sum of every byte from the first AF through the last DATA byte, XOR = XOR of the same bytes. Verified against the manual example (read all parameters,
 *  `AF AF 55 55 5A FF 00 04 1C 81 BD 50 50 AA AA A5 0D 0A`) in test/a100.test.ts. CMD bit7 = 1 write, bit6 = answer error flag (the rule of the configuration-mode command). */
export const DEFAULT_ID = Buffer.from([0x55, 0x55]);
export type A100Cmd = { write: boolean; start: number; len: number; data?: Buffer };

const inv = (b: Buffer) => Buffer.from(b.map((x) => (~x) & 0xff));
export function checkBytes(b: Buffer): [number, number] { let s = 0, x = 0; for (const v of b) { s = (s + v) & 0xff; x ^= v; } return [s, x]; }

export function buildOpFrame(c: A100Cmd, id: Buffer = DEFAULT_ID): Buffer {
  if (id.length !== 2) throw new Error("ID code must be 2 bytes");
  const data = c.write ? c.data ?? Buffer.alloc(0) : Buffer.alloc(0);
  if (c.write && data.length !== c.len) throw new Error("data length must equal LEN for a write");
  if (c.start < 0 || c.start > 0xff || c.len < 0 || c.len > 0xff) throw new Error("start and length must be one byte");
  const cmd = c.write ? 0x80 : 0x00;     // VERIFY: write command code 0x80 follows the CMD bit7 rule; only the read code 0x00 is in the manual example
  const head = Buffer.concat([Buffer.from([0xaf, 0xaf]), id, Buffer.from([0x5a, (~cmd) & 0xff, cmd, c.start, c.len]), data]);
  const [s, x] = checkBytes(head);
  return Buffer.concat([head, Buffer.from([s, x, 0x50, 0x50]), inv(id), Buffer.from([0xa5, 0x0d, 0x0a])]);
}

/** Parse one operating-mode frame (a reply from the unit, or a request in the fake A100). null = not a complete frame yet; "bad" = complete but invalid. */
export interface OpFrame { cmd: number; write: boolean; error: boolean; start: number; len: number; data: Buffer }
export function parseOpFrame(b: Buffer, id: Buffer = DEFAULT_ID): OpFrame | null | "bad" {
  const i = b.indexOf(Buffer.from([0xaf, 0xaf])); if (i < 0) return b.length >= 2 ? "bad" : null;
  const f = b.subarray(i); if (f.length < 9) return null;
  if (!f.subarray(2, 4).equals(id) || f[4] !== 0x5a || ((~f[5]) & 0xff) !== f[6]) return "bad";
  return parseWithData(f, id, f[6], f[8]);
}
function parseWithData(f: Buffer, id: Buffer, cmd: number, len: number): OpFrame | null | "bad" {
  // Try "no data" (a read request) first, then "len data bytes" (a write request or a read reply). VERIFY on the unit which of the two a reply uses.
  for (const dl of [0, len]) {
    const n = 9 + dl + 2 + 2 + 2 + 1 + 2; if (f.length < n) { if (dl === len) return null; continue; }
    const body = f.subarray(0, 9 + dl), [s, x] = checkBytes(body);
    const tail = f[11 + dl] === 0x50 && f[12 + dl] === 0x50 && f.subarray(13 + dl, 15 + dl).equals(inv(id)) && f[15 + dl] === 0xa5 && f[16 + dl] === 0x0d && f[17 + dl] === 0x0a;
    if (tail && f[9 + dl] === s && f[10 + dl] === x) return { cmd, write: (cmd & 0x80) !== 0, error: (cmd & 0x40) !== 0, start: f[7], len, data: Buffer.from(f.subarray(9, 9 + dl)) };
    if (tail) return "bad";                                       // a complete frame whose check bytes are wrong
  }
  return f.length >= 9 + len + 11 ? "bad" : null;
}

/** Configuration-mode command (RESET lamp lit, serial fixed at 9600 8N1): CMD REG LEN DATA. CMD bit7 = write, bit6 = remote (over the air), bit5 of the ANSWER = error flag
 *  (answer `0x80 REG LEN` saved, `0xC0 REG LEN` failed and unchanged, as in the manual examples). */
export function buildCfgFrame(c: { write: boolean; reg: number; len: number; data?: Buffer; remote?: boolean }): Buffer {
  const data = c.write ? c.data ?? Buffer.alloc(0) : Buffer.alloc(0);
  if (c.write && data.length !== c.len) throw new Error("data length must equal LEN for a write");
  return Buffer.concat([Buffer.from([(c.write ? 0x80 : 0) | (c.remote ? 0x40 : 0), c.reg, c.len]), data]);
}
export interface CfgAnswer { ok: boolean; write: boolean; reg: number; len: number; data: Buffer }
/** null = more bytes needed. A read reply carries LEN data bytes, a write reply echoes CMD REG LEN only. */
export function parseCfgAnswer(b: Buffer, wantReg: number): CfgAnswer | null {
  if (b.length < 3) return null; const cmd = b[0], write = (cmd & 0x80) !== 0, bad = (cmd & 0x40) !== 0 && write, reg = b[1], len = b[2];
  if (reg !== wantReg) return null;
  if (write) return { ok: !bad, write: true, reg, len, data: Buffer.alloc(0) };
  if (b.length < 3 + len) return null; return { ok: true, write: false, reg, len, data: Buffer.from(b.subarray(3, 3 + len)) };
}

/** Target transmission mode: the first 3 bytes of every outgoing frame are the destination address high, address low and channel (core-control-devices spec, DEVICES BEHIND THIS LINK). */
export function targetPrefix(addrHigh: number, addrLow: number, channel: number): Buffer {
  for (const v of [addrHigh, addrLow, channel]) if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error("address and channel must be 0 to 255");
  return Buffer.from([addrHigh, addrLow, channel]);
}

/** Answer delays from the manual: the next command must wait at least this long after the previous one. */
export const DELAY_MS = { write: 100, read: 40, version: 100, reset: 40 } as const;
