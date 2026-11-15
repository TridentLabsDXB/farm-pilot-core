// Register-map loader and validator. The runtime refuses to poll when this throws (RegMapError carries every problem found, not just the first).
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type FieldType = "i16" | "u16" | "u32" | "i32";
export interface FieldDef { reg: number; type: FieldType; scale: number; unit: string; calibrated: boolean; word_order: "high_first" | "low_first"; }
export interface TypeDef {
  key: string; enabled: boolean; label: string; models: string[]; groups: number; low_voltage: number; default_interval: number; presets: number[]; commissioning_presets: number[];
  config: { base: number; regs_per_group: number; write_fc: number[]; read_fc: number; serial: { reg: number; regs: number; word_order: "high_first" | "low_first" };
    interval: { reg: number; unit: string; min: number; max: number }; control: { reg: number; value_on_add: number } };
  data: { base: number; regs_per_channel: number; read_fc: number; fields: Record<string, FieldDef> };
}
export interface RegMap {
  gateway_model: string; manual_version: string; map_version: number; default_gateway_address: number; serial_pattern: RegExp;
  system: { address: number; group_address: number; version: number; delete_all: number; read_fc: number; write_fc: number; delete_all_value: number };
  health: { offline_multiplier: number; rssi_good_above: number; rssi_poor_below: number };
  types: Record<string, TypeDef>;
}
export class RegMapError extends Error { constructor(public problems: string[]) { super("register map invalid:\n - " + problems.join("\n - ")); } }

const isInt = (v: unknown, lo = 0, hi = 0xffff): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseRegMap(text: string): RegMap {
  const p: string[] = []; let raw: any;
  try { raw = parse(text); } catch (e: any) { throw new RegMapError(["YAML parse error: " + e.message]); }
  if (!raw || typeof raw !== "object") throw new RegMapError(["file is empty or not a mapping"]);
  if (typeof raw.gateway_model !== "string") p.push("gateway_model missing");
  if (typeof raw.manual_version !== "string") p.push("manual_version missing");
  if (!isInt(raw.map_version, 1, 1e6)) p.push("map_version must be a positive integer");
  const addr = raw.default_gateway_address;
  if (!isInt(addr, 1, 254) || addr === 123 || addr === 160) p.push("default_gateway_address must be 1..254 and never 123 or 160 (0 and 255 are broadcast)");
  let pattern = /^[0-9A-Fa-f]{8}$/; try { pattern = new RegExp(String(raw.serial_pattern ?? pattern.source)); } catch { p.push("serial_pattern is not a valid regular expression"); }
  const s = raw.system ?? {};
  for (const [k, f] of [["address", "reg"], ["group_address", "reg"], ["version", "reg"], ["delete_all", "reg"]] as const) if (!isInt(s[k]?.[f])) p.push(`system.${k}.reg missing or out of range`);
  const h = raw.health ?? {};
  if (!isInt(h.offline_multiplier ?? 3, 1, 100)) p.push("health.offline_multiplier must be 1..100");
  if (!(isNum(h.rssi_good_above ?? -90) && isNum(h.rssi_poor_below ?? -105) && (h.rssi_poor_below ?? -105) < (h.rssi_good_above ?? -90))) p.push("health RSSI thresholds: poor must be below good");

  const types: Record<string, TypeDef> = {}; const ranges: { name: string; lo: number; hi: number }[] = [];
  if (!raw.types || typeof raw.types !== "object") p.push("types missing");
  for (const [key, t] of Object.entries<any>(raw.types ?? {})) {
    const w = (m: string) => p.push(`types.${key}: ${m}`);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) w("key must be lowercase letters, digits, underscore");
    const c = t?.config ?? {}, d = t?.data ?? {};
    if (!isInt(t?.groups, 1, 255)) w("groups must be 1..255");
    if (!isInt(c.base) || !isInt(c.regs_per_group, 1, 16)) w("config.base / regs_per_group invalid");
    if (!Array.isArray(c.write_fc) || !c.write_fc.every((x: number) => x === 6 || x === 16)) w("config.write_fc must be a list of 6 and/or 16");
    if (![3, 4].includes(c.read_fc)) w("config.read_fc must be 3 or 4");
    if (![3, 4].includes(d.read_fc)) w("data.read_fc must be 3 or 4");
    if (!isInt(c.serial?.reg, 0, 15) || c.serial?.regs !== 2 || c.serial?.type !== "u32") w("config.serial must be u32 over 2 regs");
    if (!["high_first", "low_first"].includes(c.serial?.word_order)) w("config.serial.word_order must be high_first|low_first");
    for (const f of ["interval", "control"] as const) if (!isInt(c[f]?.reg, 0, 15) || (isInt(c.regs_per_group) && c[f].reg >= c.regs_per_group)) w(`config.${f}.reg outside regs_per_group`);
    if (isInt(c.serial?.reg) && isInt(c.regs_per_group) && c.serial.reg + 2 > c.regs_per_group) w("config.serial does not fit inside regs_per_group");
    if (!(isNum(c.interval?.min) && isNum(c.interval?.max) && c.interval.min > 0 && c.interval.max > c.interval.min)) w("config.interval min/max invalid");
    if (!isInt(d.base) || !isInt(d.regs_per_channel, 1, 125)) w("data.base / regs_per_channel invalid");
    const fields: Record<string, FieldDef> = {};
    if (!d.fields || !Object.keys(d.fields).length) w("data.fields missing");
    for (const [fk, f] of Object.entries<any>(d.fields ?? {})) {
      const width = f?.type === "u32" || f?.type === "i32" ? 2 : 1;
      if (!["i16", "u16", "u32", "i32"].includes(f?.type)) { w(`field ${fk}: type must be i16|u16|u32|i32`); continue; }
      if (!isInt(f.reg) || (isInt(d.regs_per_channel) && f.reg + width > d.regs_per_channel)) w(`field ${fk}: offset ${f.reg} (+${width}) is outside regs_per_channel ${d.regs_per_channel}`);
      if (!isNum(f.scale) || f.scale === 0) w(`field ${fk}: scale must be a non-zero number`);
      fields[fk] = { reg: f.reg, type: f.type, scale: f.scale, unit: String(f.unit ?? ""), calibrated: !!f.calibrated, word_order: f.word_order === "low_first" ? "low_first" : "high_first" };
    }
    for (const pv of [...(t?.presets ?? []), ...(t?.commissioning_presets ?? [])]) if (!isNum(pv) || !isNum(c.interval?.min) || pv < c.interval.min || pv > c.interval.max) w(`interval preset ${pv} is outside config.interval min..max`);
    if (isInt(t?.groups) && isInt(c.base) && isInt(c.regs_per_group)) {
      const hi = c.base + t.groups * c.regs_per_group - 1; if (hi > 0xffff) w("config range exceeds 0xFFFF"); ranges.push({ name: `${key}.config`, lo: c.base, hi });
    }
    if (isInt(t?.groups) && isInt(d.base) && isInt(d.regs_per_channel)) {
      const hi = d.base + t.groups * d.regs_per_channel - 1; if (hi > 0xffff) w("data range exceeds 0xFFFF"); ranges.push({ name: `${key}.data`, lo: d.base, hi });
    }
    types[key] = { key, enabled: t?.enabled === true, label: String(t?.label ?? key), models: Array.isArray(t?.models) ? t.models.map(String) : [], groups: t?.groups,
      low_voltage: isNum(t?.low_voltage) ? t.low_voltage : 3.2, default_interval: isInt(t?.default_interval, 1, 1e6) ? t.default_interval : 300,
      presets: Array.isArray(t?.presets) ? t.presets.filter(isNum) : [], commissioning_presets: Array.isArray(t?.commissioning_presets) ? t.commissioning_presets.filter(isNum) : [], config: { base: c.base, regs_per_group: c.regs_per_group, write_fc: c.write_fc, read_fc: c.read_fc,
        serial: { reg: c.serial?.reg, regs: 2, word_order: c.serial?.word_order }, interval: { reg: c.interval?.reg, unit: String(c.interval?.unit ?? "seconds"), min: c.interval?.min, max: c.interval?.max },
        control: { reg: c.control?.reg, value_on_add: isInt(c.control?.value_on_add) ? c.control.value_on_add : 0 } },
      data: { base: d.base, regs_per_channel: d.regs_per_channel, read_fc: d.read_fc, fields } };
  }
  // No two address ranges (config or data, any type, enabled or not) may overlap. The system registers live in a separate FC04/FC06 area and are not part of this check (FC03/FC04 split ASSUMED, verify on hardware).
  ranges.sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].lo <= ranges[i - 1].hi) p.push(`address ranges overlap: ${ranges[i - 1].name} (0x${ranges[i - 1].lo.toString(16)}-0x${ranges[i - 1].hi.toString(16)}) and ${ranges[i].name} (0x${ranges[i].lo.toString(16)}-0x${ranges[i].hi.toString(16)})`);
  if (p.length) throw new RegMapError(p);
  return { gateway_model: raw.gateway_model, manual_version: raw.manual_version, map_version: raw.map_version, default_gateway_address: addr, serial_pattern: pattern,
    system: { address: s.address.reg, group_address: s.group_address.reg, version: s.version.reg, delete_all: s.delete_all.reg, read_fc: 4, write_fc: 6, delete_all_value: s.delete_all.value ?? 0 },
    health: { offline_multiplier: h.offline_multiplier ?? 3, rssi_good_above: h.rssi_good_above ?? -90, rssi_poor_below: h.rssi_poor_below ?? -105 }, types };
}
export const loadRegMap = (path: string) => parseRegMap(readFileSync(path, "utf8"));

// ---- decoding / encoding (each register big-endian, high byte first; the transport already turns bytes into 16-bit register values) ----
export function decodeField(regs: number[], f: FieldDef): number {
  const r = (i: number) => regs[i] & 0xffff;
  let v: number;
  if (f.type === "u16") v = r(f.reg);
  else if (f.type === "i16") { v = r(f.reg); if (v & 0x8000) v -= 0x10000; }
  else { const a = r(f.reg), b = r(f.reg + 1); const u = f.word_order === "high_first" ? a * 65536 + b : b * 65536 + a; v = f.type === "i32" && u >= 0x80000000 ? u - 0x100000000 : u; }
  return Math.round(v * f.scale * 1e6) / 1e6;
}
export function decodeChannel(regs: number[], t: TypeDef): Record<string, number> {
  const o: Record<string, number> = {}; for (const [k, f] of Object.entries(t.data.fields)) o[k] = decodeField(regs, f); return o;
}
export const serialToRegs = (serial: string, order: "high_first" | "low_first"): [number, number] => {
  const n = parseInt(serial, 16); const hi = Math.floor(n / 65536) & 0xffff, lo = n & 0xffff; return order === "high_first" ? [hi, lo] : [lo, hi];
};
export const regsToSerial = (a: number, b: number, order: "high_first" | "low_first"): string => {
  const [hi, lo] = order === "high_first" ? [a, b] : [b, a]; return (((hi & 0xffff) * 65536 + (lo & 0xffff)) >>> 0).toString(16).toUpperCase().padStart(8, "0");
};
export const normaliseSerial = (s: string) => s.trim().toUpperCase();
