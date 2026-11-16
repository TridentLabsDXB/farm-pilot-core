import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-17 -- the licence and the Device ID are NOT part of a backup and a restore never changes them (the licence belongs to the box, not to the farm data).
// Backup file: no licence table, no licence file, no Device ID, no licence settings. Restore: refuses licence settings smuggled into a file; installed licence, its file and the Device ID are identical afterwards.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import type { AddressInfo } from "node:net"; import { mkdtempSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { openDb } from "../src/db.js"; import { Ingest } from "../src/ingest.js"; import { hashPassword, createSession } from "../src/auth.js"; import { buildApp } from "../src/app.js"; import { Commands } from "../src/commands.js";
import { loadRegMap } from "../src/drivers/modbus/regmap.js"; import { Registry } from "../src/gateway/registry.js"; import { GatewayService } from "../src/gateway/service.js"; import { LicenceService } from "../src/licence/service.js"; import { signLicence, type LicencePayload } from "../src/licence/format.js";

const map = loadRegMap("config/gateway-thingsend.yaml"); const A = { username: "admin", role: "admin" }; const closers: (() => void)[] = []; after(() => closers.forEach((c) => c()));
const DEV = "FP-AAAA-BBBB-CCCC", KEY = generateKeyPairSync("ed25519"), KEYS = { "t-1": (KEY.publicKey as KeyObject).export({ type: "spki", format: "der" }).toString("base64") };
const LIC = Buffer.from(signLicence({ licence_id: "FPL-20261116-0007", type: "PRO", licensed_to: "Backup Test Farm", device_id: DEV, limits: { gateways: 2, sensors: 50 }, features: [], issued_at: "2026-11-16T10:00:00Z", valid_until: null, key_id: "t-1" } as LicencePayload, KEY.privateKey));

async function boot() {
  const db = openDb(":memory:"), dir = mkdtempSync(join(tmpdir(), "fp-bk-")); const ingest = new Ingest(db), reg = new Registry(db, map), gw = new GatewayService(db, reg, ingest, null);
  const lic = new LicenceService(db, { dataDir: dir, keys: KEYS, deviceId: () => DEV });
  const { app } = await buildApp(db, ingest, new Commands(db, { publish() {} } as any, () => {}), reg, gw, null, null, lic); await app.listen({ port: 0, host: "127.0.0.1" }); closers.push(() => void app.close());
  const port = (app.server.address() as AddressInfo).port, id = Number(db.prepare("INSERT INTO users(username,pass_hash,role,created_at) VALUES('admin',?,'admin',1)").run(hashPassword("x".repeat(10))).lastInsertRowid), admin = { cookie: "core_session=" + createSession(db, id) };
  const call = async (method: string, url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie: admin.cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); const txt = await r.text(); let json: any = null; try { json = JSON.parse(txt); } catch { /* not json */ } return { status: r.status, txt, json }; };
  return { db, dir, reg, lic, call };
}

test("backup holds no licence data and no Device ID; a restore (also of a file with licence settings smuggled in) leaves the licence, its file and the Device ID exactly as they were", async () => {
  const x = await boot(); x.reg.add(A, "th", ["112600310", "112600311"]); x.lic.install(A, LIC);
  const file = join(x.dir, "licence", "current.fplic"), before = { file: readFileSync(file), sum: x.lic.summary(), row: x.db.prepare("SELECT * FROM licence").all() };
  const devBefore = (await x.call("GET", "/api/about")).json.device_id; assert.match(devBefore, /^FP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  const bk = await x.call("GET", "/api/backup"); assert.equal(bk.status, 200);
  for (const needle of [DEV, "FPL-20261116-0007", "Backup Test Farm", "fplic", "licence", "signature", "device_id"]) assert.ok(!bk.txt.toLowerCase().includes(needle.toLowerCase()), `backup must not contain "${needle}"`);
  assert.ok(!Object.keys(bk.json).some((k) => /licen|device/i.test(k)), "no licence or device key at the top level");
  assert.ok(bk.json.settings.every((s: any) => /^(gw|cal)\./.test(s.key)), "only gateway and calibration settings are exported");
  const r1 = await x.call("POST", "/api/backup/restore", bk.json); assert.equal(r1.status, 200);
  const smuggled = { ...bk.json, settings: [...bk.json.settings, { key: "licence.noted", value: "x" }], licence: { type: "PRO" } }; const r2 = await x.call("POST", "/api/backup/restore", smuggled); assert.equal(r2.status, 400, "a licence setting in a backup file is refused");
  const sm2 = await x.call("POST", "/api/backup/restore", { ...bk.json, licence: { limits: { sensors: 99999 } }, device_id: "FP-0000-0000-0000" }); assert.equal(sm2.status, 200, "unknown top-level fields are ignored, never applied");
  assert.deepEqual(readFileSync(file), before.file, "licence file unchanged"); assert.deepEqual(x.db.prepare("SELECT * FROM licence").all(), before.row, "licence row unchanged");
  const after_ = x.lic.summary(); assert.deepEqual(after_, before.sum); assert.equal(after_.state, "LICENSED");
  assert.equal((await x.call("GET", "/api/about")).json.device_id, devBefore, "the Device ID comes from the machine, a restore cannot change it");
  assert.ok(!bk.txt.includes(devBefore), "and it is not in the backup file");
});
test("Backup page says the licence is not included", () => {
  assert.match(readFileSync("web/src/Settings.tsx", "utf8"), /The licence is not included\. Upload it again on About\./);
});
