// 2026-11-18 -- A100 register map and codec (core-control-devices-ashining-a100-page.md, "Register map to expose"). Pure functions.
// The manual is inconsistent about defaults (air rate 4.8 / 2.4 kbps, 0x02FC decodes to 19.2 kbps; 81 vs 116 channels): NOTHING here assumes a default. Values always come from the unit.
// Register byte lengths and big-endian multi-byte values are CONFIRMED by the manual (core-control-devices-a100-manual-verification.md). The command LEN counts REGISTERS, the data counts BYTES (regBytes).
// The manual's own default for register 0x06 is inconsistent (02FC, 02BD, 02FA in its examples): none is used as an expected value anywhere; always read the unit.

export const REG = { VERSION: 0x00, RSSI: 0x01, BAUD: 0x04, FORMAT: 0x05, RADIO: 0x06, MODE: 0x07, ACK: 0x08, RETRY_MS: 0x09, ROLE: 0x0a, KEY: 0x0b, PACKET_LEN: 0x0e, PACK_TIME: 0x0f, WAKE: 0x14, OPTIONS: 0x17,
  LOCAL_GROUP: 0x18, LOCAL_ADDR: 0x19, DEST_GROUP: 0x1a, DEST_ADDR: 0x1b, REBOOT: 0x20, FACTORY: 0x21 } as const;
/** Byte length of each register (register table). 0x17 is 2 bytes in the register table and 1 byte in the factory table: see ALT_LEN. */
export const REG_LEN: Record<number, number> = { 0x00: 20, 0x01: 4, 0x04: 4, 0x05: 1, 0x06: 2, 0x07: 2, 0x08: 1, 0x09: 2, 0x0a: 1, 0x0b: 16, 0x0c: 5, 0x0d: 1, 0x0e: 1, 0x0f: 2, 0x14: 1, 0x16: 1, 0x17: 2, 0x18: 1, 0x19: 1, 0x1a: 1, 0x1b: 1, 0x1c: 1, 0x1d: 1, 0x1e: 1, 0x1f: 1 };
/** Lengths an ANSWER may have besides REG_LEN (read both; WRITE always sends REG_LEN bytes). Any other length is rejected. */
export const ALT_LEN: Record<number, number[]> = { 0x17: [1, 2] };
export const lengthsOf = (reg: number) => [REG_LEN[reg], ...(ALT_LEN[reg] ?? [])].filter((n) => n !== undefined);
/** Total byte length of `count` registers from `start`, or null when one of them is not in the map (then the caller cannot check). */
export function regBytes(start: number, count: number): number | null { let n = 0; for (let r = start; r < start + count; r++) { const l = REG_LEN[r]; if (l === undefined) return null; n += l; } return n; }
/** Registers the page may WRITE. 0x20 and 0x21 are separate, confirmed actions. */
export const WRITABLE = new Set([0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x0e, 0x0f, 0x17, 0x18, 0x19, 0x1a, 0x1b]);

export const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;
export const AIR_KBPS = [1.2, 2.4, 4.8, 9.6, 19.2, 38.4, 50, 62.5] as const;
export const POWER_DBM = [21, 24, 27, 30] as const;                       // bits 00, 01, 10, 11
export const MODES: Record<number, string> = { 0x0001: "transparent", 0x0002: "target transmission", 0x0004: "master-slave", 0x0020: "relay", 0x0080: "polling", 0x0400: "timed report", 0x0100: "passing", 0xf001: "control IO" };
export const OFFERED_MODES = [0x0001, 0x0002, 0x0004];                    // the rest are shown read-only as ADVANCED
export const MAX_CHANNEL = 115;                                            // 410 + 115 = 525 MHz (the electrical table); the unit refuses what it does not accept

export const channelMhz = (ch: number) => 410 + ch;

export interface Radio { channel: number; mhz: number; powerDbm: number; airKbps: number }
export function decodeRadio(v: number): Radio {
  const ch = (v >> 5) & 0x3f; return { channel: ch, mhz: channelMhz(ch), powerDbm: POWER_DBM[(v >> 3) & 3], airKbps: AIR_KBPS[v & 7] };
}
export function encodeRadio(r: { channel: number; powerDbm: number; airKbps: number }): number {
  const p = POWER_DBM.indexOf(r.powerDbm as any), a = AIR_KBPS.indexOf(r.airKbps as any);
  if (!Number.isInteger(r.channel) || r.channel < 0 || r.channel > 63) throw new Error("channel must be 0 to 63 in the register (the unit accepts its own range)");
  if (p < 0) throw new Error("power must be 21, 24, 27 or 30 dBm"); if (a < 0) throw new Error("air rate must be one of " + AIR_KBPS.join(", ") + " kbps");
  return (r.channel << 5) | (p << 3) | a;
}

export interface SerialFormat { dataBits: 8 | 9; stopBits: 1 | 2; parity: "none" | "even" | "odd" }
export function decodeFormat(v: number): SerialFormat {
  const par = (v >> 1) & 3; return { dataBits: v & 0x10 ? 9 : 8, stopBits: v & 0x20 ? 2 : 1, parity: par === 2 ? "even" : par === 3 ? "odd" : "none" };
}
export function encodeFormat(f: SerialFormat): number { return (f.dataBits === 9 ? 0x10 : 0) | (f.stopBits === 2 ? 0x20 : 0) | (f.parity === "even" ? 0b100 : f.parity === "odd" ? 0b110 : 0); }

export const decodeBaud = (b: Buffer) => b.readUInt32BE(0);
export const encodeBaud = (n: number) => { if (!(BAUDS as readonly number[]).includes(n)) throw new Error("baud must be one of " + BAUDS.join(", ")); const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export const modeName = (v: number) => MODES[v] ?? `0x${v.toString(16).padStart(4, "0")}`;

/** Register 0x08: bit7 enable, bits6..0 retransmissions (max 127). */
export const decodeAck = (v: number) => ({ enabled: (v & 0x80) !== 0, retries: v & 0x7f });
export const encodeAck = (a: { enabled: boolean; retries: number }) => { if (!Number.isInteger(a.retries) || a.retries < 0 || a.retries > 127) throw new Error("retransmissions must be 0 to 127"); return (a.enabled ? 0x80 : 0) | a.retries; };

/** Register 0x17 option bits (the ones the page shows). */
export const OPTION_BITS = { remoteConfig: 4, ackOverAir: 3, outputResult: 2, separator: 1, outputAddress: 0, randomDelay: 8, scanChannel: 9 } as const;
export const decodeOptions = (v: number) => Object.fromEntries(Object.entries(OPTION_BITS).map(([k, bit]) => [k, (v & (1 << bit)) !== 0])) as Record<keyof typeof OPTION_BITS, boolean>;
export const setOption = (v: number, k: keyof typeof OPTION_BITS, on: boolean) => (on ? v | (1 << OPTION_BITS[k]) : v & ~(1 << OPTION_BITS[k])) & 0xffff;

/** RSSI (register 0x01, 4 bytes): 2 bytes environment RSSI, 2 bytes last packet RSSI. The manual says only "convert to decimal": no dBm, no offset, no sign. They are returned and shown RAW, labelled as the unit's
 *  raw value; nothing prints "dBm" until it is checked on a real unit. */
export const decodeRssi = (b: Buffer) => ({ env: b.readUInt16BE(0), packet: b.readUInt16BE(2) });

/** Factory AES key: the ASCII text www.ashining.com. Used only to answer "is the default key still in use?"; never stored, logged, returned or shown. */
const FACTORY_KEY = Buffer.from("www.ashining.com", "ascii");
export const isFactoryKey = (k: Buffer) => k.length === 16 && k.equals(FACTORY_KEY);
