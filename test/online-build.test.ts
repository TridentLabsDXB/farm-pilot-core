import "./isolate.js";   // test data folder is a temp dir
// Release guard (2026-11-18). The bench once served a web bundle built from the WRONG branch: the sidebar logo was shifted left with the name beside it and LICENCE MANAGEMENT was gone from SYSTEM.
// Source checks alone cannot see that, so this test (1) checks the Online API switch, (2) builds the web app into a temp folder and inspects the REAL bundle and CSS,
// (3) checks the sidebar logo rules in every stylesheet. If any of it fails, do not deploy.
import test, { after } from "node:test"; import assert from "node:assert/strict";
import { execFileSync } from "node:child_process"; import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { rig } from "./rig.js";

const closers: (() => unknown)[] = []; after(() => closers.forEach((c) => c()));
const vite = join(process.cwd(), "web/node_modules/.bin/vite");
let out = ""; const bundle = () => {
  if (!out) { out = mkdtempSync(join(tmpdir(), "fp-web-build-")); closers.push(() => rmSync(out, { recursive: true, force: true })); execFileSync(process.execPath, [vite, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "silent"], { cwd: "web", stdio: "pipe", env: { ...process.env, FP_ONLINE: "" } }); }   // FP_ONLINE is a RUNTIME switch: the same bundle serves both builds
  const files = readdirSync(join(out, "assets")); return { js: files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n"), css: files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n") };
};

test("Online build: /api/me says online, the Licence Management routes exist for an Admin, an Operator is refused; a standalone build has none of it", async () => {
  const on = await rig({ online: true }); closers.push(() => void on.close()); const off = await rig({ online: false }); closers.push(() => void off.close());
  assert.equal((await on.call(on.admin, "GET", "/api/me")).json.online, true); assert.equal((await on.call(on.admin, "GET", "/api/licence-deployments")).status, 200); assert.equal((await on.call(on.op, "GET", "/api/licence-deployments")).status, 403);
  assert.equal((await off.call(off.admin, "GET", "/api/me")).json.online, undefined); assert.equal((await off.call(off.admin, "GET", "/api/licence-deployments")).status, 404);
});
test("The built web bundle carries every merged feature: LICENCE MANAGEMENT in SYSTEM, DATA SOURCES with MQTT PAYLOAD, the licence page, the MQTT page; no DATA POINTS", { timeout: 120_000 }, (t) => {
  if (!existsSync(vite)) return t.skip("web dependencies not installed");
  const { js } = bundle();
  for (const w of ["LICENCE MANAGEMENT", "MQTT PAYLOAD", "Data sources", "SENSORS GATEWAY", "DOWNLOAD", "NEW DEVICES FOUND", "/licences", "/api/licence-deployments", "SERVER CONNECTION", "CONNECTED BOXES", "PLC", "V-BOX", "ASHINING A100", "Control devices", "MAIN CORE SERVER", "WHAT THE BOX REPORTS", "/fleet/boxes", "/server-connection"]) assert.ok(js.includes(w), `the built bundle is missing "${w}"`);
  assert.ok(!/Data points|DATA POINTS/.test(js), "the old group name is still in the bundle");
  const sb = readFileSync("web/src/Sidebar.tsx", "utf8"); assert.match(sb, /g\.title === "System" && online && <button[^\n]*go\("\/licences"\)[^\n]*LICENCE MANAGEMENT/, "Online + Admin only, inside the SYSTEM group");
});
test("The built CSS keeps the sidebar logo centred, round, 104 px with the farm name under it, at every screen size above the phone", { timeout: 120_000 }, (t) => {
  if (!existsSync(vite)) return t.skip("web dependencies not installed");
  const { css } = bundle(); const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const brand = rules.filter((r) => /\.fp-sb-brand(?![-\w])/.test(r.sel) && !/\.fp-sb-brand\s+\.fp-sb-name/.test(r.sel));
  assert.ok(brand.some((r) => /flex-direction:\s*column/.test(r.body) && /align-items:\s*center/.test(r.body) && /text-align:\s*center/.test(r.body)), "the brand block must be a centred column");
  assert.ok(!brand.some((r) => /flex-direction:\s*row|text-align:\s*left/.test(r.body)), "no rule (a short-screen @media rule was the regression) may turn the brand block into a row or left-align it");
  const mark = rules.filter((r) => /\.fp-brand-mark(?![-\w])/.test(r.sel) && !/\.fp-phone-title/.test(r.sel)); assert.ok(mark.some((r) => /width:\s*104px/.test(r.body) && /height:\s*104px/.test(r.body) && /border-radius:\s*50%/.test(r.body)), "round 104 px logo");
  assert.ok(!mark.some((r) => /(^|;)\s*(width|height):\s*(?!104px)\d+px/.test(r.body)), "no rule shrinks the logo outside the phone header");
  assert.ok(!/\.fp-sb-brand\s*img/.test(css), "the old img-based rule (object-fit cover, no placeholder) must be gone");
});
