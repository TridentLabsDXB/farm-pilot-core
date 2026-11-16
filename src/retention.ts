import { audit, type Db } from "./db.js";
import { config } from "./config.js";
import type { LicenceService } from "./licence/service.js";
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
// 2026-11-17 -- `days` now comes from the licence (FREE 90, v1 licence 365, v2 as signed; see licence/range.ts): history_raw AND rollup_hourly older than `days` are removed.
// days === null means NEVER prune (licence v2 null / ENGINEERING): the rollup still runs, nothing is deleted. Returns the number of rows removed (raw + hourly); every run that removes rows is audited.
export async function runRetention(db: Db, days: number | null, now = Date.now(), batch = 5000): Promise<number> { const r = await runRetentionDetailed(db, days, now, batch); return r.raw + r.hourly; }
export interface PruneResult { raw: number; hourly: number; cutoff: string | null }
export async function runRetentionDetailed(db: Db, days: number | null, now = Date.now(), batch = 5000): Promise<PruneResult> {
  runRollup(db, now);
  if (days === null) return { raw: 0, hourly: 0, cutoff: null };
  const cutoff = now - days * 24 * HOUR;
  const del = db.prepare("DELETE FROM history_raw WHERE (series_id, ts) IN (SELECT series_id, ts FROM history_raw WHERE ts < ? LIMIT ?)");
  const delH = db.prepare("DELETE FROM rollup_hourly WHERE (series_id, hour_ts) IN (SELECT series_id, hour_ts FROM rollup_hourly WHERE hour_ts < ? LIMIT ?)");
  let raw = 0, hourly = 0, n: number;
  do { n = del.run(cutoff, batch).changes; raw += n; db.pragma("wal_checkpoint(PASSIVE)"); await new Promise((r) => setImmediate(r)); } while (n === batch);
  do { n = delH.run(cutoff, batch).changes; hourly += n; await new Promise((r) => setImmediate(r)); } while (n === batch);
  if (raw + hourly) { db.pragma("incremental_vacuum(2000)"); db.pragma("wal_checkpoint(TRUNCATE)"); audit(db, "system", "system", "retention.prune", { days, raw_rows: raw, hourly_rows: hourly, older_than: new Date(cutoff).toISOString() }); }
  return { raw, hourly, cutoff: new Date(cutoff).toISOString() };
}

// 2026-11-17 -- The scheduled run (index.ts) and the tests use this: the days come from the licence (grace-aware, see LicenceService.retentionDays), RETENTION_DAYS in the environment still overrides.
// The first prune after a downgrade grace is audited once more as licence.grace_prune (rows per table and the cutoff date) and ends the notice.
export async function runLicenceRetention(db: Db, lic: LicenceService, override: number | null = config.retentionDays): Promise<number> {
  const afterGrace = override === null && lic.graceEnded(), days = override ?? lic.retentionDays(), r = await runRetentionDetailed(db, days, lic.now());
  if (afterGrace) lic.markGracePruned({ cutoff: r.cutoff ?? "", days, history_raw: r.raw, rollup_hourly: r.hourly });
  return r.raw + r.hourly;
}
