// Bench helper: writes N sensors x 2 readings at 1/min for D days into a SCRATCH database (never the live one) and reports its size.
// Run under nice/ionice:  nice -n 19 ionice -c3 node dist/scripts/seed-bench.js /tmp/bench.db 100 1
import { rmSync, statSync } from "node:fs";
import { openDb } from "../db.js";
import { Ingest } from "../ingest.js";
import { runRollup } from "../retention.js";

const [path = "/tmp/core-bench.db", sensorsArg = "100", daysArg = "1"] = process.argv.slice(2);
if (path.startsWith("/var/lib/farmpilot-core")) throw new Error("refusing to seed the live data dir");
for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
const sensors = Number(sensorsArg), days = Number(daysArg);
const db = openDb(path); const ing = new Ingest(db);
const start = Date.now() - days * 86400_000;
const t0 = process.hrtime.bigint();
for (let m = 0; m < days * 1440; m++) {
  const ts = start + m * 60_000;
  db.transaction(() => {
    for (let s = 0; s < sensors; s++)
      ing.handle("farmpilot/bench/zone" + (s % 10), Buffer.from(JSON.stringify({ sensors: [{ key: "S" + s, readings: { temp: 20 + Math.random() * 10, humidity: 40 + Math.random() * 30 } }] })), ts);
  })();
  if (m % 120 === 0) await new Promise((r) => setImmediate(r));     // keep the box responsive
}
runRollup(db); db.pragma("wal_checkpoint(TRUNCATE)");
const rows = (db.prepare("SELECT COUNT(*) c FROM history_raw").get() as { c: number }).c;
db.close();
const size = statSync(path).size;
const secs = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(JSON.stringify({ sensors, readings_per_sensor: 2, days, raw_rows: rows, db_bytes: size, bytes_per_row: +(size / rows).toFixed(1),
  mb_per_day_per_100_sensors: +((size / days / 1048576) * (100 / sensors)).toFixed(2),
  projected_30d_mb_per_100_sensors: +((size / days * 30 / 1048576) * (100 / sensors)).toFixed(1), seconds: +secs.toFixed(1) }, null, 2));
