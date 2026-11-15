// XZ-DS-MUS2 gateway simulator (Modbus slave core). Pure logic, no sockets: handle(unit, pdu) -> response PDU or null (= stay silent).
// It follows the same register map as the runtime. DEV / BENCH ONLY: this models the manual plus the ASSUMED items; the real gateway is validated on the industrial PC.
import { exceptionPdu, MAX_READ_REGS, readRespPdu } from "../../drivers/modbus/frames.js";
import { regsToSerial, serialToRegs, type RegMap, type TypeDef } from "../../drivers/modbus/regmap.js";

export interface Phys { serial: string; temp: number; hum: number; volt: number; rssi: number; frozen: boolean; zeroed: boolean; slot: number | null; type: string; intervalMs: number; nextAt: number; voltOverride?: number; }
export interface ReplayFrame { t: number; type: string; slot: number; regs: number[]; }
export const DEFAULT_POOL = ["4A01B3F2", "4A01B3F3", "4A01B3F4", "4A01B3F5", "4A01B3F6", "4A01B3F7", "4A01B3F8", "4A01B3F9"];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class GatewaySim {
  address: number; version = 0x0200; groupAddress = 1;                    // version value is a made-up placeholder
  cfg = new Map<string, number[]>();                                       // type -> flat config registers
  data = new Map<string, number[]>();                                      // type -> flat data registers
  phys = new Map<string, Phys>();
  silent = false; rejectAll = false; rejectSerials = new Set<string>(); lenientFc = false;
  private replay: { frames: ReplayFrame[]; loop: boolean; start: number; idx: number } | null = null;
  constructor(public map: RegMap, pool: string[] = DEFAULT_POOL, now = Date.now()) {
    this.address = map.default_gateway_address;
    for (const t of Object.values(map.types)) { this.cfg.set(t.key, new Array(t.groups * t.config.regs_per_group).fill(0)); this.data.set(t.key, new Array(t.groups * t.data.regs_per_channel).fill(0)); }
    for (const s of pool) this.phys.set(s, { serial: s, temp: rnd(20, 30), hum: rnd(45, 70), volt: 3.6 - rnd(0, 0.2), rssi: -rnd(70, 95), frozen: false, zeroed: false, slot: null, type: "th", intervalMs: 0, nextAt: 0 });
    void now;
  }

  // ---- Modbus slave ----
  handle(unit: number, pdu: Buffer): Buffer | null {
    if (this.silent) return null;
    if (unit !== this.address) return null;                                // not for us (broadcast writes are never answered)
    const fc = pdu[0];
    try {
      if (fc === 3 || fc === 4) return this.read(fc, pdu.readUInt16BE(1), pdu.readUInt16BE(3));
      if (fc === 6) return this.write1(pdu.readUInt16BE(1), pdu.readUInt16BE(3), pdu);
      if (fc === 16) return this.writeN(pdu.readUInt16BE(1), pdu.readUInt16BE(3), pdu);
      return exceptionPdu(fc, 1);
    } catch { return exceptionPdu(fc, 4); }
  }
  private area(addr: number, count: number, kind: "cfg" | "data"): { t: TypeDef; off: number } | null {
    for (const t of Object.values(this.map.types)) {
      const base = kind === "cfg" ? t.config.base : t.data.base, per = kind === "cfg" ? t.config.regs_per_group : t.data.regs_per_channel;
      if (addr >= base && addr + count <= base + t.groups * per) return { t, off: addr - base };
    }
    return null;
  }
  private read(fc: 3 | 4, addr: number, count: number): Buffer {
    if (count < 1 || count > MAX_READ_REGS) return exceptionPdu(fc, 3);
    if (fc === 4 && addr + count <= 3) return readRespPdu(fc, [this.address, this.groupAddress, this.version].slice(addr, addr + count));
    const wantCfg = fc === 4;
    let a = this.area(addr, count, wantCfg ? "cfg" : "data");
    if (!a && this.lenientFc) a = this.area(addr, count, wantCfg ? "data" : "cfg");
    if (!a) return exceptionPdu(fc, 2);
    const src = (wantCfg ? this.cfg : this.data).get(a.t.key)!;
    return readRespPdu(fc, src.slice(a.off, a.off + count));
  }
  private write1(addr: number, val: number, pdu: Buffer): Buffer {
    if (this.rejectAll) return exceptionPdu(6, 4);
    if (addr === this.map.system.address) { if ([0, 123, 160, 255].includes(val)) return exceptionPdu(6, 3); this.address = val; return pdu; }
    if (addr === this.map.system.delete_all) { if (val !== 0) return exceptionPdu(6, 3); for (const t of Object.values(this.map.types)) { this.cfg.get(t.key)!.fill(0); this.data.get(t.key)!.fill(0); } this.syncPhys(); return pdu; }
    const a = this.area(addr, 1, "cfg"); if (!a) return exceptionPdu(6, 2);
    this.cfg.get(a.t.key)![a.off] = val; this.syncPhys(); return pdu;
  }
  private writeN(addr: number, count: number, pdu: Buffer): Buffer {
    if (count < 1 || count > 123 || pdu[5] !== count * 2) return exceptionPdu(16, 3);
    const a = this.area(addr, count, "cfg"); if (!a) return exceptionPdu(16, 2);
    if (this.rejectAll) return exceptionPdu(16, 4);
    const vals: number[] = []; for (let i = 0; i < count; i++) vals.push(pdu.readUInt16BE(6 + i * 2));
    const per = a.t.config.regs_per_group;
    if (this.rejectSerials.size) for (let g = 0; g * per < count; g++) { const r = vals.slice(g * per, (g + 1) * per); if (r.length === per && r.some((x) => x) && this.rejectSerials.has(regsToSerial(r[a.t.config.serial.reg], r[a.t.config.serial.reg + 1], a.t.config.serial.word_order))) return exceptionPdu(16, 4); }
    const dst = this.cfg.get(a.t.key)!; vals.forEach((v, i) => (dst[a.off + i] = v)); this.syncPhys();
    const b = Buffer.alloc(5); b[0] = 16; b.writeUInt16BE(addr, 1); b.writeUInt16BE(count, 3); return b;
  }

  /** Re-derive which physical sensor feeds which channel from the config registers. Unmatched serial or cleared group = zeros. */
  private syncPhys(now = Date.now()) {
    const was = new Map<string, number | null>([...this.phys].map(([k, p]) => [k, p.slot]));
    for (const p of this.phys.values()) { p.slot = null; }
    for (const t of Object.values(this.map.types)) {
      const c = t.config, cfg = this.cfg.get(t.key)!, data = this.data.get(t.key)!;
      for (let slot = 0; slot < t.groups; slot++) {
        const g = cfg.slice(slot * c.regs_per_group, (slot + 1) * c.regs_per_group); const empty = g.every((x) => x === 0);
        const serial = empty ? null : regsToSerial(g[c.serial.reg], g[c.serial.reg + 1], c.serial.word_order);
        const p = serial ? this.phys.get(serial) : undefined;
        if (p && p.type === t.key) { p.slot = slot; p.intervalMs = Math.max(1, g[c.interval.reg]) * 1000; if (was.get(p.serial) !== slot) p.nextAt = now + 3000; }
      }
      for (let slot = 0; slot < t.groups; slot++) {
        const fed = [...this.phys.values()].some((p) => p.type === t.key && p.slot === slot);
        if (!fed && !this.replay) data.fill(0, slot * t.data.regs_per_channel, (slot + 1) * t.data.regs_per_channel);
      }
    }
  }

  /** Advance simulated time: each configured sensor transmits at its own interval (frozen sensors do not). */
  tick(now = Date.now()) {
    if (this.replay) this.tickReplay(now);
    const t = this.map.types.th; if (!t) return;
    for (const p of this.phys.values()) {
      if (p.slot === null || p.type !== "th" || p.frozen || p.zeroed || now < p.nextAt) continue;
      p.nextAt = now + p.intervalMs;
      p.temp += rnd(-0.3, 0.3); p.hum += rnd(-1, 1); p.hum = Math.min(95, Math.max(20, p.hum)); p.volt = p.voltOverride ?? Math.max(2.5, p.volt - 0.0004); p.rssi = Math.round(-rnd(70, 95));
      const f = t.data.fields, d = this.data.get("th")!, o = p.slot * t.data.regs_per_channel;
      const enc = (v: number, scale: number, signed: boolean) => { const n = Math.round(v / scale); return signed && n < 0 ? n + 0x10000 : n & 0xffff; };
      d[o + f.temperature.reg] = enc(p.temp, f.temperature.scale, true); d[o + f.humidity.reg] = enc(p.hum, f.humidity.scale, false);
      d[o + f.voltage.reg] = enc(p.volt, f.voltage.scale, false); d[o + f.rssi.reg] = enc(p.rssi, f.rssi.scale, true);
    }
  }
  private tickReplay(now: number) {
    const r = this.replay!; const el = (now - r.start) / 1000;
    while (r.idx < r.frames.length && r.frames[r.idx].t <= el) {
      const f = r.frames[r.idx++]; const t = this.map.types[f.type]; const d = this.data.get(f.type); if (!t || !d) continue;
      f.regs.forEach((v, i) => (d[f.slot * t.data.regs_per_channel + i] = v & 0xffff));
    }
    if (r.idx >= r.frames.length && r.loop) { r.idx = 0; r.start = now; }
  }
  loadReplay(json: { loop?: boolean; frames: ReplayFrame[] }, now = Date.now()) {
    const frames = [...json.frames].sort((a, b) => a.t - b.t); this.replay = { frames, loop: !!json.loop, start: now, idx: 0 };
    for (const p of this.phys.values()) p.frozen = true;                    // recorded data replaces the synthetic sensors
  }

  // ---- failure injection and bench setup ----
  preconfigure(type: string, slot: number, serial: string, intervalSec: number, now = Date.now()) {
    const t = this.map.types[type], c = t.config, cfg = this.cfg.get(type)!, [a, b] = serialToRegs(serial, c.serial.word_order);
    const o = slot * c.regs_per_group; cfg[o + c.serial.reg] = a; cfg[o + c.serial.reg + 1] = b; cfg[o + c.interval.reg] = intervalSec; cfg[o + c.control.reg] = c.control.value_on_add; this.syncPhys(now);
  }
  freeze(serial: string, on = true) { const p = this.phys.get(serial); if (!p) return false; p.frozen = on; return true; }
  zero(serial: string) {                                                  // sensor goes dead AND its registers read zeros
    const p = this.phys.get(serial); if (!p || p.slot === null) return false; p.zeroed = true;
    const t = this.map.types[p.type]; this.data.get(p.type)!.fill(0, p.slot * t.data.regs_per_channel, (p.slot + 1) * t.data.regs_per_channel); return true;
  }
  unzero(serial: string) { const p = this.phys.get(serial); if (!p) return false; p.zeroed = false; p.nextAt = 0; return true; }
  setVoltage(serial: string, v: number | null) { const p = this.phys.get(serial); if (!p) return false; p.voltOverride = v ?? undefined; if (v !== null) p.volt = v; return true; }
  state() {
    return { address: this.address, silent: this.silent, rejectAll: this.rejectAll, rejectSerials: [...this.rejectSerials],
      sensors: [...this.phys.values()].map((p) => ({ serial: p.serial, slot: p.slot, intervalSec: p.intervalMs / 1000, frozen: p.frozen, zeroed: p.zeroed, volt: +p.volt.toFixed(3), rssi: p.rssi })),
      configured: Object.fromEntries([...this.cfg].map(([k, regs]) => { const t = this.map.types[k]; let n = 0; for (let g = 0; g < t.groups; g++) if (regs.slice(g * t.config.regs_per_group, (g + 1) * t.config.regs_per_group).some((x) => x)) n++; return [k, n]; })) };
  }
}
