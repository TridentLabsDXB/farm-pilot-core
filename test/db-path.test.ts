import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-17 -- DB_PATH is derived from DATA_DIR. Root cause of a bundle smoke test opening the live bench database: DATA_DIR alone moved the data folder but not the database.
// config.ts reads the environment once at import, so each case runs in a child process with an exact environment (no DB_PATH unless the case sets it).
import { test } from "node:test"; import assert from "node:assert/strict"; import { execFileSync } from "node:child_process"; import { readFileSync } from "node:fs"; import { join } from "node:path";
const show = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts').then(({config})=>console.log(JSON.stringify({db:config.dbPath,dir:config.dataDir})))"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" }).trim().split("\n").pop()!);

test("only DATA_DIR set: the database path is inside it", () => { const r = show({ DATA_DIR: "/tmp/fp-x/data" }); assert.deepEqual(r, { db: join("/tmp/fp-x/data", "core.db"), dir: "/tmp/fp-x/data" }); });
test("DB_PATH set explicitly wins; nothing set keeps the Linux defaults", () => {
  assert.deepEqual(show({ DATA_DIR: "/tmp/fp-x/data", DB_PATH: "/tmp/fp-y/other.db" }), { db: "/tmp/fp-y/other.db", dir: "/tmp/fp-x/data" });
  assert.deepEqual(show({}), { db: "/var/lib/farmpilot-core/core.db", dir: "/var/lib/farmpilot-core" });
});
test("startup logs the resolved database path (source)", () => { assert.match(readFileSync("src/index.ts", "utf8"), /console\.log\(`database: \$\{config\.dbPath\} \(data folder: \$\{config\.dataDir\}\)`\);\s*.*\nconst db = openDb\(config\.dbPath\)/); });
