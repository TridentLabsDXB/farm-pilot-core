// PLC point decoding. Pure. 32-bit word order is a per-PLC setting (default big-endian words = first register holds the high word); to be confirmed on the real PLC (spec open item 4).
import { pointWidth, type Area, type PointDef } from "./address.js";
export type WordOrder = "big" | "little";

/** Decodes one point from the zone's raw values (registers 0..65535, or 0/1 bits). null when the data is short or the value is not finite. */
export function decodePoint(area: Area, raw: number[], p: PointDef, order: WordOrder = "big"): number | null {
  if (area === "coils" || area === "discrete") { const b = raw[p.offset]; return b === undefined ? null : b ? 1 : 0; }
  const w = pointWidth(p.type), r = raw.slice(p.offset, p.offset + w); if (r.length < w) return null;
  let v: number;
  if (p.type === "BOOL") return r[0] !== 0 ? 1 : 0;
  if (w === 1) v = p.type === "INT16" ? (r[0] > 0x7fff ? r[0] - 0x10000 : r[0]) : r[0];
  else {
    const [hi, lo] = order === "big" ? [r[0], r[1]] : [r[1], r[0]], b = Buffer.alloc(4); b.writeUInt16BE(hi, 0); b.writeUInt16BE(lo, 2);
    v = p.type === "FLOAT32" ? b.readFloatBE(0) : p.type === "INT32" ? b.readInt32BE(0) : b.readUInt32BE(0);
  }
  const out = v * p.scale; return Number.isFinite(out) ? out : null;
}
