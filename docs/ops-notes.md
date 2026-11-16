# Ops notes (bench and lab), newest first

## 2026-11-17 -- audit row 373 is a false `licence.invalid`, from a bundle smoke test
- **What:** `audit_log` id 373, 2026-11-17 01:56:07 (+04), `licence.invalid`, "The licence file is missing from this box. Upload the licence again." The bench licence was never invalid (ENGINEERING, LICENSED before and after).
- **Cause:** while smoke-testing the unzipped Windows lab bundle on the bench, a throwaway server was started with only `DATA_DIR` set. `DB_PATH` then still defaulted to `/var/lib/farmpilot-core/core.db`, so the throwaway server opened the live database for about 5 seconds, looked for a licence file in its own empty data folder and wrote this row (and the setting `licence.noted`, which the live service resets at its next daily licence check).
- **Nothing else changed:** no commands sent, no history written, licence and users untouched, the live service kept running. `audit_log` is append-only, so the row stays; no explanatory row was added to the live database (decision of 2026-11-17).
- **Fix:** `DB_PATH` now defaults to `<DATA_DIR>/core.db` (test/db-path.test.ts) and the server logs the resolved database path as its first line. Set `DB_PATH` explicitly only to keep the database outside the data folder.
