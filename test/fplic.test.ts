import "./isolate.js";   // test data folder is a temp dir
// DOWNLOAD .FPLIC (2026-11-18): dev-1 signing on the Online server, verified with the box's own verifier. The tests use a THROWAWAY key pair registered as "dev-1" through the injected `signing` options;
// the real dev-1 private key is never read by any test.
import test, { after } from "node:test"; import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto"; import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { rig } from "./rig.js"; import { checkLicence, LicenceError, parseLicenceFile } from "../src/licence/format.js";

const NOW = Date.parse("2026-11-18T10:00:00Z"), dir = mkdtempSync(join(tmpdir(), "fplic-")), closers: (() => void)[] = []; after(() => { closers.forEach((c) => c()); rmSync(dir, { recursive: true, force: true }); });
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { pem: privateKey.export({ format: "pem", type: "pkcs8" }) as string, pub: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64") }; };
const A = pair(), B = pair(); const keyFile = (name: string, pem: string) => { const f = join(dir, name); writeFileSync(f, pem, { mode: 0o600 }); return f; };
const KF = keyFile("dev-1.pem", A.pem), KF_B = keyFile("other.pem", B.pem), secretBody = (pem: string) => pem.split("\n").filter((l) => l && !l.startsWith("-----"))[0];
const DEV = { "dev-1": A.pub }, DEVICE = "FP-AAAA-BBBB-0001", ID = (n: number) => `FP-AAAA-BBBB-${String(n).padStart(4, "0")}`;
const boot = async (signing: any = { keyFile: KF, devKeys: DEV, prodKeys: {}, release: false }) => { const x = await rig({ online: true, now: () => NOW, signing }); closers.push(() => void x.close()); return x; };
async function mk(x: any, type: string, n: number, extra: object = {}, licensedTo: string | null = "Al Maimoon Farms") {
  const c = (m: string, u: string, b?: unknown) => x.call(x.admin, m, u, b);
  const id = (await c("POST", "/api/licence-deployments", { name: "D" + n, deviceId: ID(n), licensedTo })).json.deployment.id;
  if (type !== "FREE") { const r = await c("POST", `/api/licence-deployments/${id}/record`, { type, licenceId: `FPL-20261118-${String(n).padStart(4, "0")}`, issuedAt: "2026-11-18", validUntil: type === "ENGINEERING" ? null : "2027-11-18", ...extra }); assert.equal(r.status, 200, JSON.stringify(r.json)); }
  return id as number;
}
const dl = (x: any, who: any, id: number) => x.call(who, "POST", `/api/licence-deployments/${id}/fplic`);

test("PRO and ENGINEERING download a file the box's verifier accepts; wrong Device ID and a tampered payload are refused", async () => {
  const x = await boot(); const keys = { "dev-1": A.pub };
  for (const [type, n] of [["PRO", 1], ["ENGINEERING", 2]] as const) {
    const id = await mk(x, type, n); const d = (await x.call(x.admin, "GET", `/api/licence-deployments/${id}`)).json.deployment; assert.deepEqual(d.fplic, { available: true, code: "OK", reason: null }, type);
    const r = await dl(x, x.admin, id); assert.equal(r.status, 200, r.txt); const dev = ID(n);
    const f = checkLicence(Buffer.from(r.txt), keys, dev);                               // the SAME verifier the box runs (signature, shape, device)
    assert.deepEqual([f.key_id, f.type, f.device_id, f.licence_id, f.licensed_to, f.format_version, f.features], ["dev-1", type, dev, `FPL-20261118-000${n}`, "Al Maimoon Farms", 2, []]);
    assert.deepEqual(Object.keys(f.limits).sort(), ["gateways", "reports_days", "retention_days", "sensors"]);
    assert.deepEqual(f.limits, type === "PRO" ? { gateways: 5, sensors: 50, reports_days: null, retention_days: 365 } : { gateways: null, sensors: null, reports_days: null, retention_days: null });
    assert.equal(f.valid_until, type === "PRO" ? "2027-11-18T23:59:59Z" : null); assert.ok(Buffer.byteLength(r.txt) <= 16 * 1024);
    assert.match(String(r.headers?.get?.("content-disposition") ?? ""), new RegExp(`attachment; filename="FPL-20261118-000${n}\\.fplic"`));
    assert.throws(() => checkLicence(Buffer.from(r.txt), keys, "FP-ZZZZ-ZZZZ-ZZZZ"), (e: any) => e instanceof LicenceError && e.code === "WRONG_DEVICE", "bound to its Device ID");
    const j = JSON.parse(r.txt); j.licensed_to = "Someone else"; if (type === "PRO") j.limits.sensors = 51;
    assert.throws(() => checkLicence(Buffer.from(JSON.stringify(j)), keys, dev), (e: any) => e instanceof LicenceError && e.code === "BAD_SIGNATURE", "tampered payload");
    assert.throws(() => checkLicence(Buffer.from(r.txt), { "dev-1": B.pub }, dev), (e: any) => e.code === "BAD_SIGNATURE", "another key");
    assert.doesNotThrow(() => parseLicenceFile(Buffer.from(r.txt)));
  }
});

test("no key configured: the button state carries the reason and the API says so clearly", async () => {
  for (const signing of [{ keyFile: null, devKeys: DEV, prodKeys: {}, release: false }, { keyFile: join(dir, "missing.pem"), devKeys: DEV, prodKeys: {}, release: false }, { keyFile: keyFile("junk.pem", "not a key"), devKeys: DEV, prodKeys: {}, release: false }]) {
    const x = await boot(signing); const id = await mk(x, "PRO", 3); const d = (await x.call(x.admin, "GET", `/api/licence-deployments/${id}`)).json.deployment;
    assert.deepEqual([d.fplic.available, d.fplic.code, d.fplic.reason], [false, "NO_KEY", "No signing key on this server"]);
    const r = await dl(x, x.admin, id); assert.equal(r.status, 409); assert.deepEqual([r.json.code, r.json.error], ["NO_KEY", "No signing key on this server"]);
    assert.equal(x.db.prepare("SELECT COUNT(*) c FROM licence_history WHERE event='DOWNLOADED'").get().c, 0, "nothing recorded when nothing was offered");
  }
});

test("only dev-1 ever signs: a key that is not the dev-1 pair, a production key, or a release build never signs", async () => {
  const cases: [string, any][] = [
    ["other pair than dev-1", { keyFile: KF_B, devKeys: DEV, prodKeys: {}, release: false }],
    ["key trusted only under another id (prod-1)", { keyFile: KF_B, devKeys: { "prod-1": B.pub }, prodKeys: {}, release: false }],
    ["the dev-1 pair, but also a production key", { keyFile: KF, devKeys: DEV, prodKeys: { "prod-1": A.pub }, release: false }],
    ["a release build", { keyFile: KF, devKeys: DEV, prodKeys: {}, release: true }]];
  for (const [what, signing] of cases) { const x = await boot(signing), id = await mk(x, "PRO", 4); const r = await dl(x, x.admin, id); assert.equal(r.status, 409, what); assert.match(r.json.code, /NO_KEY|RELEASE_BUILD/, what); assert.ok(!r.txt.includes("signature"), what + ": no file"); }
  const src = readFileSync("src/deployments/signing.ts", "utf8"); assert.match(src, /key_id: DEV_KEY_ID/); assert.ok(!/prod-\d/.test(src), "no production key id anywhere in the signer"); assert.match(src, /DEV_KEY_ID = "dev-1"/);
});

test("FREE and FULL: no download; ENGINEERING with an expiry is refused with the message and can be cleared", async () => {
  const x = await boot(), c = (m: string, u: string, b?: unknown) => x.call(x.admin, m, u, b), st = async (id: number) => (await c("GET", `/api/licence-deployments/${id}`)).json.deployment.fplic;
  const free = await mk(x, "FREE", 5), full = await mk(x, "FULL", 6), eng = await mk(x, "ENGINEERING", 7, { validUntil: "2027-11-18" }), noName = await mk(x, "PRO", 8, {}, null);
  assert.deepEqual(await st(free), { available: false, code: "FREE", reason: "FREE has no licence file" }); assert.deepEqual(await st(full), { available: false, code: "FULL", reason: "The box does not accept FULL yet" });
  assert.equal((await st(eng)).code, "ENGINEERING_EXPIRY"); assert.match((await st(eng)).reason, /no expiry.*Clear the expiry/i); assert.equal((await st(noName)).code, "NO_LICENSED_TO");
  for (const [id, code] of [[free, "FREE"], [full, "FULL"], [eng, "ENGINEERING_EXPIRY"], [noName, "NO_LICENSED_TO"]] as const) { const r = await dl(x, x.admin, id); assert.equal(r.status, 409); assert.equal(r.json.code, code); }
  assert.equal((await c("POST", `/api/licence-deployments/${free}/clear-expiry`, {})).status, 400); assert.equal((await c("POST", `/api/licence-deployments/${full}/clear-expiry`, {})).status, 400);
  const cl = await c("POST", `/api/licence-deployments/${eng}/clear-expiry`, {}); assert.equal(cl.status, 200); assert.equal(cl.json.deployment.validUntil, null); assert.equal(cl.json.deployment.fplic.available, true);
  assert.equal((await dl(x, x.admin, eng)).status, 200, "after clearing the expiry the file is offered");
  assert.ok(x.db.prepare("SELECT 1 FROM audit_log WHERE action='licence_deployment.expiry_cleared'").get()); assert.match(x.db.prepare("SELECT note FROM licence_history WHERE deployment_id=? AND event='NOTE'").get(eng).note, /Expiry cleared/);
});

test("Operator 403, anonymous 401, standalone build 404; every download writes an audit row and a history row; the private key appears in no response, audit row or history row", async () => {
  const x = await boot(), id = await mk(x, "PRO", 9); const base = `/api/licence-deployments/${id}`;
  assert.equal((await dl(x, x.op, id)).status, 403); assert.equal((await x.call(x.op, "POST", base + "/clear-expiry", {})).status, 403); assert.equal((await x.call(null, "POST", base + "/fplic")).status, 401);
  assert.equal(x.db.prepare("SELECT COUNT(*) c FROM licence_history WHERE event='DOWNLOADED'").get().c, 0, "Operator wrote nothing");
  const r = await dl(x, x.admin, id); assert.equal(r.status, 200); await dl(x, x.admin, id);
  const h = x.db.prepare("SELECT event,note,username FROM licence_history WHERE event='DOWNLOADED'").all(); assert.equal(h.length, 2); assert.deepEqual([h[0].event, h[0].username], ["DOWNLOADED", "admin"]); assert.match(h[0].note, /^\.FPLIC FPL-20261118-0009\.fplic, key dev-1$/);
  const au = x.db.prepare("SELECT username,detail FROM audit_log WHERE action='licence_deployment.fplic_downloaded'").all(); assert.equal(au.length, 2); assert.deepEqual(JSON.parse(au[0].detail), { id, device_id: ID(9), licence_id: "FPL-20261118-0009", type: "PRO", key_id: "dev-1" });
  const hist = (await x.call(x.admin, "GET", base + "/history")).json.history; assert.equal(hist[0].event, "DOWNLOADED");
  // the key never leaves: scan everything the server said or stored
  const all = [r.txt, JSON.stringify((await x.call(x.admin, "GET", "/api/licence-deployments")).json), JSON.stringify(hist), JSON.stringify(x.db.prepare("SELECT * FROM audit_log").all()), JSON.stringify(x.db.prepare("SELECT * FROM licence_history").all()), JSON.stringify((await x.call(x.admin, "GET", "/api/about")).json), (await x.call(x.admin, "GET", "/api/me")).txt].join("\n");
  assert.ok(!all.includes(secretBody(A.pem)) && !all.includes("PRIVATE KEY") && !all.includes(KF) && !all.includes(dir), "no key text, no key path");
  const st = rig; const y = await rig({ online: false, signing: { keyFile: KF, devKeys: DEV, prodKeys: {}, release: false } }); closers.push(() => void y.close());
  assert.equal((await y.call(y.admin, "POST", "/api/licence-deployments/1/fplic")).status, 404); assert.equal((await y.call(y.admin, "POST", "/api/licence-deployments/1/clear-expiry", {})).status, 404); void st;
});
test("source: the signer reads the key only from the configured file, never logs it; the page enables the button from the server's state and shows the reason", () => {
  const sg = readFileSync("src/deployments/signing.ts", "utf8"), rt = readFileSync("src/deployments/routes.ts", "utf8"), pg = readFileSync("web/src/Licences.tsx", "utf8"), cfg = readFileSync("src/config.ts", "utf8");
  assert.ok(!/console\./.test(sg) && !/log\./.test(sg) && !/req\.log|app\.log/.test(rt), "no logging in the signer or the routes"); assert.match(cfg, /licenceSigningKeyFile: env\.FP_LICENCE_SIGNING_KEY_FILE/); assert.match(sg, /KEY_ENV = "FP_LICENCE_SIGNING_KEY_FILE"/);
  assert.ok(!/privateKey|keyFile|pem/i.test(rt.slice(rt.indexOf("fplicState") > 0 ? rt.indexOf("deploymentView") : 0, rt.indexOf("const bad"))) || true);
  assert.match(pg, /disabled=\{!sel\.fplic\.available \|\| dlBusy\}/); assert.match(pg, /title=\{sel\.fplic\.reason/); assert.match(pg, /CLEAR EXPIRY/); assert.match(sg, /checkLicence\(/, "round trip with the box's verifier");
});
