// Modbus framing: PDU builders/parsers, RTU (CRC16) and MBAP (TCP) wrappers, and stream length detection for RTU.
export class ModbusException extends Error { constructor(public fc: number, public code: number) { super(`modbus exception ${code} on fc ${fc}`); this.name = "ModbusException"; } }
export class ModbusTimeout extends Error { constructor(m = "modbus timeout") { super(m); this.name = "ModbusTimeout"; } }
export const MAX_READ_REGS = 125;     // Modbus limit for FC03/FC04
export const MAX_WRITE_REGS = 123;    // FC16

export function crc16(b: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < b.length; i++) { crc ^= b[i]; for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1; }
  return crc;
}
export const readPdu = (fc: 3 | 4, addr: number, count: number) => { const b = Buffer.alloc(5); b[0] = fc; b.writeUInt16BE(addr, 1); b.writeUInt16BE(count, 3); return b; };
export const write1Pdu = (addr: number, val: number) => { const b = Buffer.alloc(5); b[0] = 6; b.writeUInt16BE(addr, 1); b.writeUInt16BE(val & 0xffff, 3); return b; };
export const writeNPdu = (addr: number, vals: number[]) => {
  const b = Buffer.alloc(6 + vals.length * 2); b[0] = 16; b.writeUInt16BE(addr, 1); b.writeUInt16BE(vals.length, 3); b[5] = vals.length * 2;
  vals.forEach((v, i) => b.writeUInt16BE(v & 0xffff, 6 + i * 2)); return b;
};
export const exceptionPdu = (fc: number, code: number) => Buffer.from([fc | 0x80, code]);
export const readRespPdu = (fc: number, vals: number[]) => { const b = Buffer.alloc(2 + vals.length * 2); b[0] = fc; b[1] = vals.length * 2; vals.forEach((v, i) => b.writeUInt16BE(v & 0xffff, 2 + i * 2)); return b; };

/** Decode a response PDU for a request PDU. Throws ModbusException on an exception response. */
export function parseResponse(req: Buffer, res: Buffer): number[] {
  const fc = req[0];
  if (res[0] === (fc | 0x80)) throw new ModbusException(fc, res[1]);
  if (res[0] !== fc) throw new Error(`unexpected function code ${res[0]} for request ${fc}`);
  if (fc === 3 || fc === 4) {
    const n = res[1]; if (n !== req.readUInt16BE(3) * 2 || res.length < 2 + n) throw new Error("short or wrong-sized read response");
    const out: number[] = []; for (let i = 0; i < n / 2; i++) out.push(res.readUInt16BE(2 + i * 2)); return out;
  }
  return []; // FC06 / FC16 echo
}

export const rtuWrap = (unit: number, pdu: Buffer) => { const b = Buffer.alloc(pdu.length + 3); b[0] = unit; pdu.copy(b, 1); b.writeUInt16LE(crc16(b.subarray(0, b.length - 2)), b.length - 2); return b; };
export function rtuUnwrap(frame: Buffer): { unit: number; pdu: Buffer } | null {
  if (frame.length < 4 || crc16(frame.subarray(0, frame.length - 2)) !== frame.readUInt16LE(frame.length - 2)) return null;
  return { unit: frame[0], pdu: frame.subarray(1, frame.length - 2) };
}
/** Expected total RTU frame length from the bytes seen so far. 0 = need more bytes, -1 = not a known function code. role: what the receiver expects (req on a slave, res on a master). */
export function rtuFrameLength(b: Buffer, role: "req" | "res"): number {
  if (b.length < 2) return 0; const fc = b[1];
  if (fc & 0x80) return role === "res" ? 5 : -1;
  if (fc === 3 || fc === 4) return role === "req" ? 8 : b.length < 3 ? 0 : 5 + b[2];
  if (fc === 6) return 8;
  if (fc === 16) return role === "res" ? 8 : b.length < 7 ? 0 : 9 + b[6];
  return -1;
}
export const mbapWrap = (tid: number, unit: number, pdu: Buffer) => { const b = Buffer.alloc(7 + pdu.length); b.writeUInt16BE(tid & 0xffff, 0); b.writeUInt16BE(0, 2); b.writeUInt16BE(pdu.length + 1, 4); b[6] = unit; pdu.copy(b, 7); return b; };
export function mbapLength(b: Buffer): number { return b.length < 6 ? 0 : 6 + b.readUInt16BE(4); }
