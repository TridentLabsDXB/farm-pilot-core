// 2026-11-18 -- MONITORING wiring for PLC points and V-BOX tags. How MONITORING resolves farm values (traced): the zone card (gateway/health.ts buildView), the chart endpoint and the CSV export
// (history/routes.ts) all read per-sensor series by (topic, sensor_key, metric) with metric temperature or humidity; the Farm Structure `points` table is only a list shown on that page.
// A PLC point or V-BOX tag whose "maps to" is a farm point ("<farm zone id>:temperature" or ":humidity", chosen from the Farm Structure zones) therefore becomes a VIRTUAL SENSOR of that
// zone: it is averaged into the zone card, drawn as a line in CHARTS and exported in the CSV, with the label of its data zone / V-BOX unit. An UNMAPPED value is stored and never shown.
// Operators get the label and the value only, never a register address, a point offset or a raw value. All of this is read only and never blocks the rest of CORE.
import type { Db } from "../db.js";
import type { Metric } from "../history/logic.js";
import { PLC_SERIES_TOPIC } from "../plc/schema.js";
import { VBOX_SERIES_TOPIC } from "../vbox/defaults.js";

export const MAP_METRICS: Metric[] = ["temperature", "humidity"];
const ROLE: Record<Metric, string> = { temperature: "Air temperature", humidity: "Air humidity" };
/** V-BOX publishes on its own schedule (unknown until the real payload arrives): a V-BOX value counts as NO UPDATE after this long without a message (placeholder). */
export const VBOX_EXPECTED_MS = 5 * 60_000;

export const parseMapsTo = (v: unknown): { zoneId: number; metric: Metric } | null => { const m = typeof v === "string" ? /^(\d{1,9}):(temperature|humidity)$/.exec(v) : null; return m ? { zoneId: Number(m[1]), metric: m[2] as Metric } : null; };
/** The farm points an Admin can choose in the "maps to" list: every Farm Structure zone with its air temperature and air humidity. */
export function farmPointOptions(db: Db): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const z of db.prepare("SELECT id,name FROM zones ORDER BY sort,name").all() as { id: number; name: string }[]) for (const m of MAP_METRICS) out.push({ value: `${z.id}:${m}`, label: `${z.name} · ${ROLE[m]}` });
  return out;
}
/** "" or a chosen farm point; throws an Error with a plain sentence otherwise. */
export function checkMapsTo(db: Db, v: unknown, what: string): string {
  if (v === undefined || v === null || v === "") return "";
  const p = parseMapsTo(v); if (!p) throw new Error(`${what}: maps to must be a farm point from the list`);
  if (!db.prepare("SELECT 1 FROM zones WHERE id=?").get(p.zoneId)) throw new Error(`${what}: that farm zone no longer exists`);
  return `${p.zoneId}:${p.metric}`;
}

export interface MappedSource { zoneId: number; kind: "plc" | "vbox"; label: string; topic: string; key: string; serial: string; metrics: Partial<Record<Metric, string>>; intervalMs: number; }
/** Virtual sensors per farm zone. Each (farm zone, data zone or V-BOX unit) is one sensor; a second point of the same metric starts another one. Only sources that have stored a value are listed. */
export function mappedSources(db: Db): MappedSource[] {
  const out: MappedSource[] = []; const has = db.prepare("SELECT 1 FROM series WHERE topic=? AND sensor_key=? AND metric=?");
  const add = (kind: MappedSource["kind"], zoneId: number, label: string, topic: string, key: string, serial: string, metric: Metric, series: string, intervalMs: number) => {
    if (!has.get(topic, key, series)) return;
    let s = out.find((x) => x.zoneId === zoneId && x.topic === topic && x.key === key && !x.metrics[metric]);
    if (!s) out.push((s = { zoneId, kind, label: out.some((x) => x.zoneId === zoneId && x.topic === topic && x.key === key) ? `${label} 2` : label, topic, key, serial, metrics: {}, intervalMs }));
    s.metrics[metric] = series;
  };
  try {
    const poll = Number((db.prepare("SELECT poll_s FROM plc_config WHERE id=1").get() as { poll_s: number } | undefined)?.poll_s ?? 5) * 1000;
    for (const r of db.prepare("SELECT p.name pname, p.maps_to mt, z.code, z.name zname FROM plc_points p JOIN plc_zones z ON z.id=p.zone_id WHERE p.maps_to<>'' ORDER BY z.sort, z.id, p.off").all() as { pname: string; mt: string; code: string; zname: string }[]) {
      const m = parseMapsTo(r.mt); if (m && db.prepare("SELECT 1 FROM zones WHERE id=?").get(m.zoneId)) add("plc", m.zoneId, r.zname, PLC_SERIES_TOPIC, r.code, `PLC:${r.code}`, m.metric, r.pname, poll);
    }
  } catch { /* the PLC tables do not exist yet (tests, first start) */ }
  try {
    for (const u of db.prepare("SELECT unit_id FROM vbox_units WHERE state='added' ORDER BY first_seen").all() as { unit_id: string }[])
      for (const t of db.prepare("SELECT name,maps_to mt FROM vbox_tags WHERE maps_to<>'' ORDER BY sort,id").all() as { name: string; mt: string }[]) {
        const m = parseMapsTo(t.mt); if (m && db.prepare("SELECT 1 FROM zones WHERE id=?").get(m.zoneId)) add("vbox", m.zoneId, `V-BOX ${u.unit_id}`, VBOX_SERIES_TOPIC, u.unit_id, `VBOX:${u.unit_id}`, m.metric, t.name, VBOX_EXPECTED_MS);
      }
  } catch { /* the V-BOX tables do not exist yet */ }
  return out;
}
/** Latest value and time per metric of one virtual sensor. */
export function latestOf(db: Db, s: MappedSource): Partial<Record<Metric, { v: number; t: number }>> {
  const q = db.prepare("SELECT l.value v, l.ts t FROM latest l JOIN series x ON x.id=l.series_id WHERE x.topic=? AND x.sensor_key=? AND x.metric=?"), out: Partial<Record<Metric, { v: number; t: number }>> = {};
  for (const m of MAP_METRICS) { const n = s.metrics[m]; if (n) { const r = q.get(s.topic, s.key, n) as { v: number; t: number } | undefined; if (r) out[m] = r; } }
  return out;
}
export const seriesIdOf = (db: Db, s: MappedSource, metric: Metric): number | null => { const n = s.metrics[metric]; return n ? ((db.prepare("SELECT id FROM series WHERE topic=? AND sensor_key=? AND metric=?").get(s.topic, s.key, n) as { id: number } | undefined)?.id ?? null) : null; };
/** NO UPDATE when nothing arrived for three expected intervals (at least one minute). */
export const mappedStatus = (lastAt: number, now: number, intervalMs: number): "ok" | "no_update" => (now - lastAt <= Math.max(60_000, 3 * intervalMs) ? "ok" : "no_update");

/** Keeps the Farm Structure `points` list in step with the mappings: one row per mapped PLC point / V-BOX tag (serial PLC:<zone code>:<point> or VBOX:<tag>). Only rows with those prefixes are touched. */
export function syncFarmPoints(db: Db) {
  db.transaction(() => {
    db.prepare("DELETE FROM points WHERE serial LIKE 'PLC:%' OR serial LIKE 'VBOX:%'").run(); const ins = db.prepare("INSERT OR IGNORE INTO points(zone_id,serial,metric,role,unit) VALUES(?,?,?,?,?)");
    const ok = (id: number) => db.prepare("SELECT 1 FROM zones WHERE id=?").get(id);
    try { for (const r of db.prepare("SELECT p.name, p.unit, p.maps_to mt, z.code FROM plc_points p JOIN plc_zones z ON z.id=p.zone_id WHERE p.maps_to<>''").all() as { name: string; unit: string; mt: string; code: string }[]) { const m = parseMapsTo(r.mt); if (m && ok(m.zoneId)) ins.run(m.zoneId, `PLC:${r.code}:${r.name}`, m.metric, ROLE[m.metric], r.unit); } } catch { /* no PLC tables */ }
    try { for (const t of db.prepare("SELECT name, unit, maps_to mt FROM vbox_tags WHERE maps_to<>''").all() as { name: string; unit: string; mt: string }[]) { const m = parseMapsTo(t.mt); if (m && ok(m.zoneId)) ins.run(m.zoneId, `VBOX:${t.name}`, m.metric, ROLE[m.metric], t.unit); } } catch { /* no V-BOX tables */ }
  })();
}
