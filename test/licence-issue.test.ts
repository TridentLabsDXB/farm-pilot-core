import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// Issuing tool (Step 5): keygen / sign / verify end to end, the private key can never live in the repo, and the tool is outside the shipped build.
import { test } from "node:test"; import assert from "node:assert/strict"; import { execFileSync, spawnSync } from "node:child_process"; import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { checkLicence } from "../src/licence/format.js"; import { LICENCE_PUBLIC_KEYS } from "../src/licence/keys.js"; import { LicenceService } from "../src/licence/service.js"; import { openDb } from "../src/db.js";

const tool = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", "tools/licence-issue/index.ts", ...a], { encoding: "utf8" });
const DEV = "FP-AAAA-BBBB-CCCC";

test("keygen, sign, verify: a file issued by the tool verifies in the tool and on a box that holds the public key, and a box refuses it for another Device ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-issue-")); const k = tool("keygen", "--key-id", "test-9", "--out", dir); assert.equal(k.status, 0, k.stderr); assert.match(k.stdout, /"test-9": "MCow/);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "test-9.private.pem")).mode & 0o077, 0, "private key is owner-only"); assert.equal(tool("keygen", "--key-id", "test-9", "--out", dir).status, 2, "never overwrites a key");
  const pubKey = readFileSync(join(dir, "test-9.public.txt"), "utf8").trim(), out = join(dir, "farm.fplic");
  const s = tool("sign", "--key", join(dir, "test-9.private.pem"), "--key-id", "test-9", "--device", DEV, "--licensed-to", "Al Maimoon Farms", "--type", "FULL", "--gateways", "2", "--sensors", "50", "--valid-until", "2099-12-31", "--features", "weather,fans", "--seq", "7", "--out", out); assert.equal(s.status, 0, s.stderr + s.stdout);
  const f = JSON.parse(readFileSync(out, "utf8")); assert.equal(f.valid_until, "2099-12-31T23:59:59Z"); assert.match(f.licence_id, /^FPL-\d{8}-0007$/); assert.equal(f.format_version, 2); assert.deepEqual(f.limits, { gateways: 2, sensors: 50, reports_days: 365, retention_days: 365 }); assert.deepEqual(f.features, ["weather", "fans"]); assert.equal(f.type, "FULL");
  const v = tool("verify", out, "--public-key", pubKey, "--device", DEV); assert.equal(v.status, 0, v.stdout); assert.match(v.stdout, /^OK: FPL-\d{8}-0007 FULL for Al Maimoon Farms/);
  const wrong = tool("verify", out, "--public-key", pubKey, "--device", "FP-1111-2222-3333"); assert.equal(wrong.status, 1); assert.match(wrong.stdout, /^WRONG_DEVICE: /);
  assert.equal(tool("verify", out).status, 1, "against the keys built into this CORE version the test key is unknown"); assert.match(tool("verify", out).stdout, /^BAD_SIGNATURE/);
  const tampered = join(dir, "t.fplic"); writeFileSync(tampered, readFileSync(out, "utf8").replace("Al Maimoon", "Al Maimoom")); assert.match(tool("verify", tampered, "--public-key", pubKey).stdout, /^BAD_SIGNATURE/);
  const db = openDb(":memory:"), lic = new LicenceService(db, { dataDir: mkdtempSync(join(tmpdir(), "fp-i2-")), keys: { "test-9": pubKey }, deviceId: () => DEV });
  assert.equal(lic.install({ username: "admin", role: "admin" }, readFileSync(out)).state, "LICENSED"); assert.deepEqual(lic.summary().limits, { gateways: 2, sensors: 50 }); assert.deepEqual([lic.summary().reports_days, lic.summary().retention_days], [365, 365]);
  assert.throws(() => new LicenceService(openDb(":memory:"), { dataDir: mkdtempSync(join(tmpdir(), "fp-i3-")), keys: { "test-9": pubKey }, deviceId: () => "FP-9999-9999-9999" }).install({ username: "a", role: "admin" }, readFileSync(out)), /another box/);
  void checkLicence;
});
test("bad input is explained, nothing is written: bad Device ID, missing option, bad date, key id", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-issue2-")); tool("keygen", "--key-id", "k1", "--out", dir); const base = ["sign", "--key", join(dir, "k1.private.pem"), "--key-id", "k1", "--licensed-to", "X", "--type", "FULL", "--gateways", "1", "--sensors", "5", "--out", join(dir, "o.fplic")];
  for (const [extra, re] of [[["--device", "FP-12"], /--device must look like/], [["--device", DEV, "--valid-until", "next year"], /--valid-until/], [["--device", DEV, "--licence-id", "X1"], /--licence-id/]] as [string[], RegExp][]) { const r = tool(...base, ...extra); assert.equal(r.status, 2); assert.match(r.stderr, re); assert.ok(!existsSync(join(dir, "o.fplic"))); }
  { const noType = base.filter((x, i) => !(x === "--type" || base[i - 1] === "--type")); const r = tool(...noType, "--device", DEV); assert.equal(r.status, 2); assert.match(r.stderr, /--type is required/); } assert.match(tool("nonsense").stderr, /commands: keygen \| sign \| batch \| verify/);
  assert.match(tool("keygen", "--key-id", "BAD ID", "--out", dir).stderr, /key-id/);
});
test("the private key can never live in the repository: the tool refuses to write or read one inside it, no tracked file contains a private key, and tools/ is outside the build and the export", () => {
  const out = tool("keygen", "--key-id", "r1", "--out", join(process.cwd(), "somewhere")); assert.equal(out.status, 2); assert.match(out.stderr, /inside the repository/); assert.ok(!existsSync("somewhere"));
  const inside = join(process.cwd(), "web", "x.private.pem"); writeFileSync(inside, "x"); try { const s = tool("sign", "--key", inside, "--key-id", "k", "--device", DEV, "--licensed-to", "X", "--type", "FULL", "--gateways", "1", "--sensors", "1"); assert.equal(s.status, 2); assert.match(s.stderr, /inside the repository/); } finally { execFileSync("rm", ["-f", inside]); }
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter((f) => f && existsSync(f) && !f.includes("node_modules") && statSync(f).isFile() && statSync(f).size < 2_000_000 && !/\.(png|webp|ico|woff2?|zip)$/.test(f) && f !== "test/licence-issue.test.ts");
  const hits = tracked.filter((f) => /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(readFileSync(f, "utf8"))); assert.deepEqual(hits, [], "no private key in any repository file");
  assert.ok(!existsSync("dist/licence-issue") && JSON.parse(readFileSync("tsconfig.json", "utf8")).include.join() === "src", "tools/ is not compiled into dist"); assert.match(readFileSync(".gitattributes", "utf8"), /^tools\/ export-ignore/m);
  assert.ok(Object.keys(LICENCE_PUBLIC_KEYS).length >= 1 && Object.values(LICENCE_PUBLIC_KEYS).every((v) => !/PRIVATE/.test(v)));
});
