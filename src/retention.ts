import type { Db } from "./db.js";
const HOUR = 3600_000;

// Hourly rollup: idempotent upsert of every hour from (last rolled hour - 1) up to the current hour. The open hour is recomputed each run.
export function runRollup(db: Db, now = Date.now()) {
  const last = (db.prepare("SELECT MAX(hour_ts) m FROM rollup_hourly").get() as { m: number | null }).m;
  const first = db.prepare("SELECT MIN(ts) m FROM history_raw").get() as { m: number | null };
  const from = Math.floor(((last !== null ? last - HOUR : first.m ?? now)) / HOUR) * HOUR;
  db.prepare(`INSERT INTO rollup_hourly(series_id,hour_ts,avg,min,max,n)
    SELECT series_id, (ts/${HOUR})*${HOUR}, AVG(value), MIN(value), MAX(value), COUNT(*) FROM history_raw WHERE ts >= ? GROUP BY series_id, ts/${HOUR}
    ON CONFLICT(series_id,hour_ts) DO UPDATE SET avg=excluded.avg,min=excluded.min,max=excluded.max,n=excluded.n`).run(from);
}

// Retention in small batches. Each batch is its own short transaction (writers are never blocked for long), we yield to the event loop
// between batches, checkpoint the WAL, and give freed pages back with incremental_vacuum. Rollup runs FIRST so no hour is lost.
export async function runRetention(db: Db, days: number, now = Date.now(), batch = 5000): Promise<number> {
  runRollup(db, now);
  const cutoff = now - days * 24 * HOUR;
  const del = db.prepare("DELETE FROM history_raw WHERE (series_id, ts) IN (SELECT series_id, ts FROM history_raw WHERE ts < ? LIMIT ?)");
  let total = 0, n: number;
  do {
    n = del.run(cutoff, batch).changes; total += n;
    db.pragma("wal_checkpoint(PASSIVE)");
    await new Promise((r) => setImmediate(r));
  } while (n === batch);
  if (total) { db.pragma("incremental_vacuum(2000)"); db.pragma("wal_checkpoint(TRUNCATE)"); }
  return total;
}
