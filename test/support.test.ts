// Diagnostics and support bundle (Step 4): Admin only, valid ZIP, the content is what the spec lists, and a SCAN proves no password hash, token or session secret is inside.
import { test, after } from "node:test"; import assert from "node:assert/strict"; import { execFileSync } from "node:child_process"; import { inflateRawSync } from "node:zlib"; import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { config } from "../src/config.js"; import { setSetting } from "../src/db.js"; import { makeZip } from "../src/about/zip.js"; import { pushLog, recentErrors, recentLines, clearLogsForTests, sanitizeLine, installLogCapture } from "../src/about/logbuf.js";
import { CONFIG_SHOWN, CONFIG_EXCLUDED, sanitizedConfig, sanitizedSettings } from "../src/about/support.js"; import { rig } from "./rig.js";

const closers: (() => unknown)[] = []; after(() => Promise.all(closers.map((c) => c())));
/** Reads a ZIP the way any unzip tool does (central directory), so a malformed archive fails here too. */
function readZip(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(eocd >= 0, "end of central directory"); const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out: Record<string, Buffer> = {};
  for (let i = 0; i < n; i++) { assert.equal(buf.readUInt32LE(p), 0x02014b50); const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42); const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(lo + 26), lel = buf.readUInt16LE(lo + 28), data = buf.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csize); out[name] = method === 8 ? inflateRawSync(data) : data; p += 46 + nl + el + cl; }
  return out;
}
const leaks = (text: string, secrets: string[]) => [...secrets.filter((s) => s && text.includes(s)).map((s) => `contains ${s.slice(0, 12)}...`), ...(/scrypt\$[0-9a-f]{8,}/i.test(text) ? ["a scrypt hash"] : []), ...(/core_session=(?!\[removed\])\S/i.test(text) ? ["a session cookie"] : [])];

test("zip writer: a valid archive (read back by our reader, by unzip -t and by Python), UTF-8 names, empty and binary files", () => {
  const z = makeZip([{ name: "a.txt", data: "hello" }, { name: "dir/ü.json", data: "{}" }, { name: "empty", data: "" }, { name: "bin", data: Buffer.from([0, 1, 2, 255]) }]);
  const r = readZip(z); assert.equal(r["a.txt"].toString(), "hello"); assert.equal(r["dir/ü.json"].toString(), "{}"); assert.equal(r["empty"].length, 0); assert.deepEqual([...r["bin"]], [0, 1, 2, 255]);
  const f = join(mkdtempSync(join(tmpdir(), "fp-zip-")), "t.zip"); writeFileSync(f, z);
  try { assert.match(execFileSync("unzip", ["-t", f], { encoding: "utf8" }), /No errors detected/); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  try { assert.equal(execFileSync("python3", ["-I", "-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(','.join(sorted(z.namelist())))", f], { encoding: "utf8" }).trim(), "a.txt,bin,dir/ü.json,empty"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
});
test("log buffer: cookies, tokens, passwords and password hashes are removed when a line is stored; only the last 20 errors and 500 lines are kept; the real stdout capture works", () => {
  clearLogsForTests();
  const bad = ["GET /api/x cookie: core_session=AbCdEf123456-_token; Path=/", '{"password":"hunter2hunter2","pass_hash":"scrypt$aabbccdd$11223344556677889900","user":"admin"}', "Authorization: Bearer abc.def.ghi", "login ok password=SuperSecret99 token=xyz", "set-cookie: core_session=ZZZZ9999; HttpOnly", '{"token_hash":"deadbeefdeadbeef","signature":"sigsigsig"}'];
  for (const l of bad) assert.deepEqual(leaks(sanitizeLine(l), ["hunter2hunter2", "AbCdEf123456", "SuperSecret99", "abc.def.ghi", "ZZZZ9999", "deadbeefdeadbeef", "sigsigsig", "11223344556677889900", "xyz"]), [], l);
  assert.ok(sanitizeLine('{"user":"admin","msg":"hello"}').includes('"msg":"hello"'), "ordinary text is kept");
  for (let i = 0; i < 30; i++) pushLog(`{"level":50,"msg":"boom ${i}"}`); for (let i = 0; i < 600; i++) pushLog(`line ${i}`); assert.equal(recentErrors().length, 20); assert.match(recentErrors()[19], /boom 29/); assert.match(recentErrors()[0], /boom 10/); assert.equal(recentLines().length, 500);
  clearLogsForTests(); installLogCapture(); process.stdout.write("hello from stdout core_session=LIVETOKEN123\n"); process.stderr.write("an error line\n"); assert.ok(recentLines().some((l) => l.includes("hello from stdout")) && !recentLines().join("").includes("LIVETOKEN123")); assert.deepEqual(recentErrors(), ["an error line"]);
});
test("config is an allow-list: every key of config is either shown or deliberately excluded; settings with secret-looking names never export", () => {
  for (const k of Object.keys(config)) assert.ok((CONFIG_SHOWN as readonly string[]).includes(k) || (CONFIG_EXCLUDED as readonly string[]).includes(k), `config.${k} must be added to CONFIG_SHOWN or CONFIG_EXCLUDED in about/support.ts`);
  assert.ok(!("mqttHost" in sanitizedConfig())); assert.equal(sanitizedConfig().port, config.port);
});

test("API: Operator gets 403 on /api/diagnostics and /api/support-bundle; Admin gets the diagnostics JSON (versions, host, licence, ports, gateway link, last errors) and a ZIP named farmpilot-core-support-<farm>-<date>.zip; the bundle export is audited", async () => {
  const x = await rig(); closers.push(x.close); clearLogsForTests(); for (let i = 0; i < 25; i++) pushLog(`{"level":50,"msg":"e${i}"}`);
  for (const u of ["/api/diagnostics", "/api/support-bundle"]) { assert.equal((await x.call(x.op, "GET", u)).status, 403, u); assert.equal((await x.call(null, "GET", u)).status, 401, u); }
  const d = (await x.call(x.admin, "GET", "/api/diagnostics")).json; assert.equal(d.product, "FARM-PILOT CORE"); assert.equal(typeof d.version, "string"); assert.ok(d.build && d.label !== undefined); assert.ok(d.host.computer_name && d.host.sqlite_version); assert.equal(d.licence.state, "FREE"); assert.ok(Array.isArray(d.ports)); assert.deepEqual(Object.keys(d.gateway_link).sort(), ["enabled", "last_error", "last_ok", "online"]); assert.equal(d.last_errors.length, 20); assert.match(d.last_errors[19], /e24/);
  const z = await x.call(x.admin, "GET", "/api/support-bundle"); assert.equal(z.status, 200); assert.equal(z.headers.get("content-type"), "application/zip"); assert.match(z.headers.get("content-disposition")!, /^attachment; filename="farmpilot-core-support-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip"$/);
  const files = readZip(z.buf); assert.deepEqual(Object.keys(files).sort(), ["README.txt", "config.json", "diagnostics.json", "licence.json", "logs/recent.log", "ports-and-devices.json"]); assert.equal(JSON.parse(files["diagnostics.json"].toString()).licence.state, "FREE");
  assert.equal((x.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='support.bundle'").get() as any).c, 1);
});
test("SCAN: a bundle built from a database full of secrets contains no password hash, token, token hash, session secret or admin password file content", async () => {
  const x = await rig(); closers.push(x.close); clearLogsForTests();
  // Everything a leak could come from: user hashes, live session cookies (and their stored hashes), secret-looking settings, secrets in log lines, secrets in the environment.
  const hashes = (x.db.prepare("SELECT pass_hash FROM users").all() as { pass_hash: string }[]).map((r) => r.pass_hash); assert.ok(hashes.length >= 2 && hashes.every((h) => h.startsWith("scrypt$")));
  const tokenHashes = (x.db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[]).map((r) => r.token_hash); const cookies = [x.admin.cookie, x.op.cookie]; const tokens = cookies.map((c) => c.split("=")[1]);
  assert.equal(tokenHashes.length, 2); setSetting(x.db, "session_secret", "SECRET-SETTING-VALUE-1"); setSetting(x.db, "gw.api_token", "SECRET-SETTING-VALUE-2"); setSetting(x.db, "gw.poll_sec", "30"); process.env.SESSION_SECRET = "SECRET-ENV-VALUE-3"; process.env.CORE_ADMIN_PASSWORD = "SECRET-ENV-VALUE-4";
  pushLog(`request headers: cookie: ${x.admin.cookie}; user-agent: x`); pushLog(`{"user":"admin","pass_hash":"${hashes[0]}"}`); pushLog(`debug password=SECRET-LOG-VALUE-5 token=${tokens[1]}`); pushLog(`stored ${tokenHashes[0]} ${hashes[1]}`.replace(/scrypt\$/g, "scrypt$"));
  await x.call(x.admin, "GET", "/api/about"); const z = await x.call(x.admin, "GET", "/api/support-bundle"); assert.equal(z.status, 200);
  const files = readZip(z.buf), all = Object.entries(files).map(([n, b]) => `### ${n}\n${b.toString("utf8")}`).join("\n");
  const secrets = [...hashes, ...hashes.map((h) => h.split("$")[2]), ...tokens, ...cookies, ...tokenHashes, "SECRET-SETTING-VALUE-1", "SECRET-SETTING-VALUE-2", "SECRET-ENV-VALUE-3", "SECRET-ENV-VALUE-4", "SECRET-LOG-VALUE-5"];
  assert.deepEqual(leaks(all, secrets), [], "the support bundle must contain no secret"); assert.ok(all.includes('"gw.poll_sec": "30"'), "allowed settings are exported"); assert.ok(!all.includes("session_secret") && !all.includes("gw.api_token"), "secret-looking settings are not even named");
  assert.ok(!/SESSION_SECRET|CORE_ADMIN_PASSWORD/.test(all), "the environment is never exported"); assert.ok(all.includes("[removed]") || all.includes("[password hash removed]"), "the log lines were sanitised, not dropped silently");
  // the scan itself must be able to fail: the same check over an UNsanitised line catches the hash and the cookie
  assert.ok(leaks(`pass_hash ${hashes[0]} ${cookies[0]}`, [...hashes, ...cookies]).length >= 2, "the scan detects a leak when there is one");
  const diag = JSON.stringify(JSON.parse((await x.call(x.admin, "GET", "/api/diagnostics")).txt)); assert.deepEqual(leaks(diag, secrets), [], "the COPY DIAGNOSTICS text is clean too");
  delete process.env.SESSION_SECRET; delete process.env.CORE_ADMIN_PASSWORD;
});
test("UI wiring (source): THIS COMPUTER card has COPY DIAGNOSTICS and SUPPORT BUNDLE (download link to /api/support-bundle)", async () => {
  const ab = (await import("node:fs")).readFileSync("web/src/About.tsx", "utf8"); assert.match(ab, /COPY DIAGNOSTICS/); assert.match(ab, /href="\/api\/support-bundle" download>SUPPORT BUNDLE</); assert.match(ab, /api<unknown>\("\/diagnostics"\)/); assert.match(ab, /execCommand\("copy"\)/, "copy works on plain HTTP too");
});
