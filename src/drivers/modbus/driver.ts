// Register-map aware gateway driver. All addresses and function codes come from the map, nothing is hard-coded here, so a new sensor type is a config block.
import { decodeChannel, groupIsEmpty, regsToSerial, serialToRegs, type RegMap, type TypeDef } from "./regmap.js";
import type { ModbusMaster, Priority } from "./master.js";

export interface Group { slot: number; serial: string | null; interval: number; control: number; }
export interface Channel { slot: number; regs: number[]; values: Record<string, number>; allZero: boolean; }
const FORBIDDEN_ADDR = new Set([0, 123, 160, 255]);

export class GatewayDriver {
  constructor(public master: ModbusMaster, public map: RegMap) {}
  type(key: string): TypeDef { const t = this.map.types[key]; if (!t) throw new Error("unknown sensor type " + key); return t; }

  /** 2026-11-17 (Windows lab, real XZ-DS-MUS2 address 7): the system area answers ONE register per read. A request for count 3 got a 7-byte reply (1 register) and the reader waited for 11 bytes,
   *  so the gateway went OFFLINE. The manual reads each system register on its own (01 04 0000 0001, 01 04 0001 0001, 01 04 0002 0001) and so do we, never as one multi-register read.
   *  Each register is optional: a failure is recorded in `problems` (the caller logs it) and the value stays undefined. The system registers only fill the GATEWAY info card;
   *  they never decide ONLINE (the config / data poll does). After two failures in a row the rest is skipped, so a dead bus does not cost three timeouts here before the real poll reports it. */
  async readSystem(): Promise<{ address?: number; groupAddress?: number; version?: number; problems: string[] }> {
    const out: { address?: number; groupAddress?: number; version?: number; problems: string[] } = { problems: [] }; let streak = 0;
    for (const [key, name, reg] of [["address", "address", this.map.system.address], ["groupAddress", "PID", this.map.system.group_address], ["version", "version", this.map.system.version]] as const) {
      if (streak >= 2) { out.problems.push(`${name} register 0x${reg.toString(16).padStart(4, "0")} skipped after 2 failed reads`); continue; }
      try { const [v] = await this.master.read(this.map.system.read_fc as 4, reg, 1); if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff) { out[key] = v; streak = 0; } else { out.problems.push(`${name} register returned an unexpected value`); streak++; } }
      catch (e) { out.problems.push(`${name} register: ${String((e as Error)?.message ?? e)}`); streak++; }
    }
    return out;
  }
  /** Read the config groups of a type with the configured read FC (FC04), all groups in one or two requests. */
  async readConfig(typeKey: string, prio: Priority = "poll"): Promise<Group[]> {
    const t = this.type(typeKey), c = t.config;
    return this.decodeGroups(typeKey, await this.master.read(c.read_fc as 3 | 4, c.base, t.groups * c.regs_per_group, prio));
  }
  /** Raw config registers -> groups. Never throws on odd data: a short array reads as empty groups. Empty = every register zero, both serial registers 0xFFFF (never configured, CONFIRMED),
   *  or a serial of 0 / 0xFFFFFFFF (2026-11-17: such a group is not a sensor, whatever the other registers hold). */
  decodeGroups(typeKey: string, regs: number[]): Group[] {
    const t = this.type(typeKey), c = t.config; const groups: Group[] = [];
    for (let slot = 1; slot <= t.groups; slot++) {          // slots are numbered 1..groups; the register address uses slot-1
      const g = Array.from({ length: c.regs_per_group }, (_, i) => regs[(slot - 1) * c.regs_per_group + i] ?? 0);
      const serial = regsToSerial(g[c.serial.reg], g[c.serial.reg + 1], c.serial.word_order);
      const empty = groupIsEmpty(g, c, this.map.empty_marker) || serial === "0" || serial === "4294967295";   // 0xFFFF = never configured (CONFIRMED), zeros = cleared
      groups.push({ slot, serial: empty ? null : serial, interval: empty ? 0 : g[c.interval.reg], control: empty ? 0 : g[c.control.reg] });
    }
    return groups;
  }
  /** Read channel data (FC03) only up to the highest configured slot (1-based), not all groups. Channel i of the result is slot i+1. */
  async readData(typeKey: string, highestSlot: number, prio: Priority = "poll"): Promise<Channel[]> {
    const t = this.type(typeKey), d = t.data; if (highestSlot > t.groups) throw new Error("slot out of range (1.." + t.groups + ")"); const n = highestSlot; if (n <= 0) return [];
    const regs = await this.master.read(d.read_fc as 3 | 4, d.base, n * d.regs_per_channel, prio);
    const out: Channel[] = [];
    for (let i = 0; i < n; i++) { const slot = i + 1; const r = regs.slice(i * d.regs_per_channel, (i + 1) * d.regs_per_channel); out.push({ slot, regs: r, values: decodeChannel(r, t), allZero: r.every((x) => x === 0) }); }
    return out;
  }
  /** Address of the first data register of a slot's channel: data.base + (slot - 1) * regs_per_channel. Refuses slots outside 1..groups. */
  dataAddr(typeKey: string, slot: number) { const t = this.type(typeKey); if (!Number.isInteger(slot) || slot < 1 || slot > t.groups) throw new Error("slot out of range (1.." + t.groups + ")"); return t.data.base + (slot - 1) * t.data.regs_per_channel; }
  groupRegs(typeKey: string, g: { serial: string; interval: number; control?: number }): number[] {
    const t = this.type(typeKey), c = t.config; const r = new Array(c.regs_per_group).fill(0);
    const [a, b] = serialToRegs(g.serial, c.serial.word_order); r[c.serial.reg] = a; r[c.serial.reg + 1] = b; r[c.interval.reg] = g.interval; r[c.control.reg] = g.control ?? c.control.value_on_add; return r;
  }
  groupAddr(typeKey: string, slot: number) { const t = this.type(typeKey); if (!Number.isInteger(slot) || slot < 1 || slot > t.groups) throw new Error("slot out of range (1.." + t.groups + ")"); return t.config.base + (slot - 1) * t.config.regs_per_group; }
  async writeGroup(typeKey: string, slot: number, g: { serial: string; interval: number; control?: number }) {
    const t = this.type(typeKey); if (!t.config.write_fc.includes(16)) throw new Error("type has no FC16 write");
    if (g.interval < t.config.interval.min || g.interval > t.config.interval.max) throw new Error(`interval ${g.interval} outside ${t.config.interval.min}..${t.config.interval.max}`);
    return this.master.writeN(this.groupAddr(typeKey, slot), this.groupRegs(typeKey, g), "write");
  }
  async clearGroup(typeKey: string, slot: number) { const t = this.type(typeKey); return this.master.writeN(this.groupAddr(typeKey, slot), new Array(t.config.regs_per_group).fill(0), "write"); }
  /** FC06 write 0 to the delete-all register: removes EVERY configured sensor on the gateway. Callers must have an explicit Admin confirmation. */
  deleteAll() { return this.master.write1(this.map.system.delete_all, this.map.system.delete_all_value, "write"); }
  /** Explicit Admin tool only. Refuses 0, 255 (broadcast), 123 and 160. */
  async setAddress(newAddr: number) {
    if (!Number.isInteger(newAddr) || newAddr < 1 || newAddr > 254 || FORBIDDEN_ADDR.has(newAddr)) throw new Error("gateway address must be 1..254 and never 123 or 160");
    await this.master.write1(this.map.system.address, newAddr, "write"); this.master.setUnit(newAddr);
  }
}
