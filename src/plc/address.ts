// PLC data zones: address conversion, the exact Modbus request, and validation. PURE (no I/O). READ ONLY: only function codes 01, 02, 03 and 04 exist here.
// Address styles: "plc" = 40001 is the first holding register (coils 00001, discrete inputs 10001, input registers 30001); "protocol" = 0 is the first.
// PLC style covers the classic 5-digit ranges (offsets 0..9998 inside an area); a bigger offset needs the protocol style.
export type Area = "holding" | "input" | "coils" | "discrete";
export type Style = "plc" | "protocol";
export const AREAS: Area[] = ["holding", "input", "coils", "discrete"];
export const STYLES: Style[] = ["plc", "protocol"];
export const READ_FC: Record<Area, 1 | 2 | 3 | 4> = { coils: 1, discrete: 2, holding: 3, input: 4 };
const PREFIX: Record<Area, number> = { coils: 0, discrete: 10000, input: 30000, holding: 40000 };
export const MAX_REQUEST_REGS = 120;        // Modbus allows 125; CORE uses at most 120 (owner spec)
export const MAX_REQUEST_BITS = 1920;
export const MAX_ZONE_LENGTH = 2000;
const isBits = (a: Area) => a === "coils" || a === "discrete";

/** Typed start address -> 0-based protocol offset. Throws Error with a plain sentence. */
export function toOffset(area: Area, style: Style, start: number): number {
  if (!Number.isInteger(start) || start < 0) throw new Error("start address must be a whole number, 0 or more");
  if (style === "protocol") { if (start > 65535) throw new Error("start address is above 65535"); return start; }
  const p = PREFIX[area];
  if (start < p + 1 || start > p + 9999) throw new Error(`in PLC style ${area} ${area === "coils" ? "addresses are 00001 to 09999" : `addresses are ${p + 1} to ${p + 9999}`}; use the protocol style for other addresses`);
  return start - p - 1;
}
/** 0-based offset -> the number shown in PLC style (null when it does not fit the classic range). */
export function toPlcAddress(area: Area, offset: number): number | null { return offset >= 0 && offset <= 9998 ? PREFIX[area] + offset + 1 : null; }

export interface ZoneDef { area: Area; style: Style; start: number; length: number; }
export interface Request { fc: 1 | 2 | 3 | 4; offset: number; count: number; }
export interface ZoneRequest { fc: 1 | 2 | 3 | 4; offset: number; end: number; length: number; plcStart: number | null; plcEnd: number | null; chunks: Request[]; }
/** The exact requests for a zone: a zone longer than one request allows is split (registers 120, bits 1920). */
export function zoneRequest(z: ZoneDef): ZoneRequest {
  if (!AREAS.includes(z.area)) throw new Error("area must be holding, input, coils or discrete");
  if (!STYLES.includes(z.style)) throw new Error("address style must be plc or protocol");
  if (!Number.isInteger(z.length) || z.length < 1 || z.length > MAX_ZONE_LENGTH) throw new Error(`length must be 1 to ${MAX_ZONE_LENGTH}`);
  const offset = toOffset(z.area, z.style, z.start), end = offset + z.length - 1;
  if (end > 65535) throw new Error("the zone runs past address 65535");
  if (z.style === "plc" && end > 9998) throw new Error("the zone runs past the PLC style range; use the protocol style");
  const fc = READ_FC[z.area], max = isBits(z.area) ? MAX_REQUEST_BITS : MAX_REQUEST_REGS, chunks: Request[] = [];
  for (let o = 0; o < z.length; o += max) chunks.push({ fc, offset: offset + o, count: Math.min(max, z.length - o) });
  return { fc, offset, end, length: z.length, plcStart: toPlcAddress(z.area, offset), plcEnd: toPlcAddress(z.area, end), chunks };
}

export const POINT_TYPES = ["INT16", "UINT16", "INT32", "UINT32", "FLOAT32", "BOOL"] as const;
export type PointType = (typeof POINT_TYPES)[number];
export const pointWidth = (t: PointType): number => (t === "INT32" || t === "UINT32" || t === "FLOAT32" ? 2 : 1);
export interface PointDef { offset: number; name: string; type: PointType; scale: number; unit: string; }
/** Points of one zone: offset inside the zone (0 = first register), no overlap, inside the length, bit areas hold BOOL only. Returns an error sentence or null. */
export function checkPoints(area: Area, length: number, points: PointDef[]): string | null {
  const used = new Map<number, string>(), names = new Set<string>();
  for (const [i, p] of points.entries()) {
    const n = `point ${i + 1}`;
    if (!p || typeof p !== "object") return `${n}: invalid`;
    if (typeof p.name !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(p.name)) return `${n}: name must be lower case letters, digits or _ (max 32)`;
    if (names.has(p.name)) return `${n}: name ${p.name} is used twice`; names.add(p.name);
    if (!POINT_TYPES.includes(p.type)) return `${n}: type must be one of ${POINT_TYPES.join(", ")}`;
    if (isBits(area) && p.type !== "BOOL") return `${n}: a ${area} zone holds BOOL points only`;
    if (!Number.isInteger(p.offset) || p.offset < 0) return `${n}: offset must be a whole number, 0 or more`;
    const w = isBits(area) ? 1 : pointWidth(p.type);
    if (p.offset + w > length) return `${n}: ${p.name} at offset ${p.offset} (${w} wide) is outside the zone length ${length}`;
    for (let k = p.offset; k < p.offset + w; k++) { const o = used.get(k); if (o) return `${n}: ${p.name} overlaps ${o} at offset ${k}`; used.set(k, p.name); }
    if (typeof p.scale !== "number" || !Number.isFinite(p.scale) || p.scale === 0 || Math.abs(p.scale) > 1e9) return `${n}: scale must be a number other than 0`;
    if (typeof p.unit !== "string" || p.unit.length > 12) return `${n}: unit is at most 12 characters`;
  }
  return null;
}
