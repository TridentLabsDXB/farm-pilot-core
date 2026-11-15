// Register-map aware gateway driver. All addresses and function codes come from the map, nothing is hard-coded here, so a new sensor type is a config block.
import { decodeChannel, regsToSerial, serialToRegs, type RegMap, type TypeDef } from "./regmap.js";
import type { ModbusMaster, Priority } from "./master.js";

export interface Group { slot: number; serial: string | null; interval: number; control: number; }
export interface Channel { slot: number; regs: number[]; values: Record<string, number>; allZero: boolean; }
const FORBIDDEN_ADDR = new Set([0, 123, 160, 255]);

export class GatewayDriver {
  constructor(public master: ModbusMaster, public map: RegMap) {}
  type(key: string): TypeDef { const t = this.map.types[key]; if (!t) throw new Error("unknown sensor type " + key); return t; }

  async readSystem() {
    const [address, groupAddress, version] = await this.master.read(this.map.system.read_fc as 4, this.map.system.address, 3);
    return { address, groupAddress, version };
  }
  /** Read the config groups of a type with the configured read FC (FC04), all groups in one or two requests. */
  async readConfig(typeKey: string, prio: Priority = "poll"): Promise<Group[]> {
    const t = this.type(typeKey), c = t.config;
    const regs = await this.master.read(c.read_fc as 3 | 4, c.base, t.groups * c.regs_per_group, prio);
    const groups: Group[] = [];
    for (let slot = 1; slot <= t.groups; slot++) {          // slots are numbered 1..groups; the register address uses slot-1
      const g = regs.slice((slot - 1) * c.regs_per_group, slot * c.regs_per_group);
      const empty = g.every((x) => x === 0);
      groups.push({ slot, serial: empty ? null : regsToSerial(g[c.serial.reg], g[c.serial.reg + 1], c.serial.word_order), interval: g[c.interval.reg], control: g[c.control.reg] });
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
