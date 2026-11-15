// Rehearse the database migration on a COPY: node --import tsx scripts/rehearse-migration.ts <copy.db>. Never point it at the live database (it opens it read-write and migrates it).
import Database from "better-sqlite3"; import { openDb } from "../src/db.js";
const path = process.argv[2]; const counts = (d: any) => Object.fromEntries(["users", "sensors", "zones", "points", "calibrations", "audit_log", "history_raw", "series", "latest", "commands", "settings", "sessions"].map((t) => [t, d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
const pre = new Database(path, { readonly: true }); const before = counts(pre); const hadTable = !!pre.prepare("SELECT 1 FROM sqlite_master WHERE name='alarm_events'").get(); const slotsBefore = pre.prepare("SELECT serial,slot,sent_slot FROM sensors ORDER BY serial").all(); pre.close();
const db = openDb(path); const after = counts(db);
console.log("alarm_events existed before:", hadTable, "| exists now:", !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='alarm_events'").get());
console.log("alarm_events columns:", (db.prepare("PRAGMA table_info(alarm_events)").all() as any[]).map((c) => c.name).join(","));
console.log("indexes:", (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='alarm_events'").all() as any[]).map((i) => i.name).join(","));
const same = JSON.stringify(before) === JSON.stringify(after); console.log("row counts unchanged:", same, same ? "" : JSON.stringify({ before, after }));
console.log("slots unchanged:", JSON.stringify(slotsBefore) === JSON.stringify(db.prepare("SELECT serial,slot,sent_slot FROM sensors ORDER BY serial").all()));
console.log("integrity_check:", db.pragma("integrity_check", { simple: true }), "| foreign_key_check rows:", (db.pragma("foreign_key_check") as any[]).length);
db.close(); const db2 = openDb(path); console.log("second open ok, slots_1based =", (db2.prepare("SELECT value FROM settings WHERE key='slots_1based'").get() as any)?.value, "| min slot", (db2.prepare("SELECT MIN(slot) m FROM sensors").get() as any).m); db2.close();
