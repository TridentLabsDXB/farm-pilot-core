// Test isolation (2026-11-17): src/config.ts defaults DATA_DIR to the REAL /var/lib/farmpilot-core. On the bench that folder holds the installed licence
// file, and a test that builds LicenceService(db) with an in-memory database then saw "file present, no installed row" = INVALID instead of FREE
// (about.test.ts and support.test.ts failed only on the bench). Worse, a test that installed or removed a licence would have touched the real file.
// This module is loaded first (npm test --import, and the first import of rig.ts) and points DATA_DIR at a fresh temp folder, before config.ts is read.
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const REAL = "/var/lib/farmpilot-core";
if (!process.env.DATA_DIR || process.env.DATA_DIR === REAL) process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "fp-test-data-"));
