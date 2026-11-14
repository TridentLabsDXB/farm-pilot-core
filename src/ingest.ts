import type { Db } from "./db.js";

// Unified payload (same shape as the main Farm-Pilot): { "ts": "<iso>", "sensors": [ { "key": "AIR1", "type": "...", "readings": { "temp": 24.1 } } ] }
// Non-numeric or non-finite readings are skipped, never an error: a bad field must not kill the whole message.
export interface LiveSensor { key: string; readings: Record<string, number>; }
export interface LiveTopic { topic: string; ts: number; sensors: LiveSensor[]; }

export class Ingest {
  private seriesId = new Map<string, number>();
  private getSeries; private upLatest; private insRaw;
  constructor(private db: Db) {
    const ins = db.prepare("INSERT OR IGNORE INTO series(topic,sensor_key,metric) VALUES(?,?,?)");
    const sel = db.prepare("SELECT id FROM series WHERE topic=? AND sensor_key=? AND metric=?");
    this.getSeries = (t: string, k: string, m: string) => {
      const ck = `${t}\u0000${k}\u0000${m}`; let id = this.seriesId.get(ck);
      if (id === undefined) { ins.run(t, k, m); id = (sel.get(t, k, m) as { id: number }).id; this.seriesId.set(ck, id); }
      return id;
    };
    this.upLatest = db.prepare("INSERT INTO latest(series_id,value,ts) VALUES(?,?,?) ON CONFLICT(series_id) DO UPDATE SET value=excluded.value, ts=excluded.ts");
    this.insRaw = db.prepare("INSERT OR REPLACE INTO history_raw(series_id,ts,value) VALUES(?,?,?)");
  }

  handle(topic: string, buf: Buffer, now = Date.now()): LiveTopic | null {
    let p: any; try { p = JSON.parse(buf.toString("utf8")); } catch { return null; }
    if (!p || !Array.isArray(p.sensors)) return null;
    const sensors: LiveSensor[] = [];
    for (const s of p.sensors) {
      if (!s || typeof s.key !== "string" || !s.readings || typeof s.readings !== "object") continue;
      const readings: Record<string, number> = {};
      for (const [m, v] of Object.entries(s.readings)) if (typeof v === "number" && Number.isFinite(v)) readings[m] = v;
      if (Object.keys(readings).length) sensors.push({ key: s.key, readings });
    }
    if (!sensors.length) return null;
    this.db.transaction(() => {
      for (const s of sensors) for (const [m, v] of Object.entries(s.readings)) {
        const id = this.getSeries(topic, s.key, m);
        this.upLatest.run(id, v, now); this.insRaw.run(id, now, v);
      }
    })();
    return { topic, ts: now, sensors };
  }

  snapshot(): LiveTopic[] {
    const rows = this.db.prepare("SELECT s.topic,s.sensor_key,s.metric,l.value,l.ts FROM latest l JOIN series s ON s.id=l.series_id").all() as any[];
    const by = new Map<string, LiveTopic>();
    for (const r of rows) {
      let t = by.get(r.topic); if (!t) by.set(r.topic, (t = { topic: r.topic, ts: 0, sensors: [] }));
      t.ts = Math.max(t.ts, r.ts);
      let s = t.sensors.find((x) => x.key === r.sensor_key); if (!s) t.sensors.push((s = { key: r.sensor_key, readings: {} }));
      s.readings[r.metric] = r.value;
    }
    return [...by.values()];
  }
}
