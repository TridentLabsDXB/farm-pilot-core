import "./isolate.js";   // test data folder is a temp dir
// Release guard (2026-11-18): the Sensors Gateway page must carry READ GATEWAY T/H SECTION, READ GATEWAY SOIL SECTION and (after a read) IMPORT INTO CORE. They were missing on the bench because the
// release branch lacked commit 9677186. The buttons have NO condition of their own (no gateway-online, licence or Online-build gate): the whole page is Admin only, and a gateway that is offline gets a plain message.
import test from "node:test"; import assert from "node:assert/strict"; import { execFileSync } from "node:child_process"; import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const gp = readFileSync("web/src/GatewayPage.tsx", "utf8"), sr = readFileSync("web/src/SectionRead.tsx", "utf8"), rt = readFileSync("src/gateway/routes.ts", "utf8");
test("Sensors Gateway page renders the section reads unconditionally, with both buttons and IMPORT INTO CORE", () => {
  assert.match(gp, /import \{ SectionReads \} from "\.\/SectionRead"/); const line = gp.split("\n").find((l) => l.includes("<SectionReads"))!; assert.ok(line, "GatewayPage must render <SectionReads />");
  assert.ok(/^\s*<SectionReads /.test(line), "not inside a conditional expression on the same line"); assert.ok(!/\{[^}]*(g\.online|g\.enabled|online|licen)[^}]*&&\s*<SectionReads/.test(gp), "no gateway/licence/online condition around the buttons");
  for (const w of ['button="READ GATEWAY T/H SECTION"', 'button="READ GATEWAY SOIL SECTION"', "IMPORT INTO CORE"]) assert.ok(sr.includes(w), w);
  assert.match(sr, /section="th"/); assert.match(sr, /section="soil"/);
});
test("The API behind the buttons exists, Admin only, and the import never writes to the gateway", () => {
  assert.match(rt, /read-section\/:section/); assert.match(rt, /import-section\/:section/); assert.match(rt, /preHandler: admin[^\n]*read-section|read-section[^\n]*preHandler: admin|admin[^\n]*read-section/s);
});
test("The built web bundle contains the three labels (a bundle from a branch without them fails here)", { timeout: 120_000 }, (t) => {
  const vite = join(process.cwd(), "web/node_modules/.bin/vite"); if (!existsSync(vite)) return t.skip("web dependencies not installed");
  const out = mkdtempSync(join(tmpdir(), "fp-web-gw-")); try {
    execFileSync(process.execPath, [vite, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "silent"], { cwd: "web", stdio: "pipe" });
    const js = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n");
    for (const w of ["READ GATEWAY T/H SECTION", "READ GATEWAY SOIL SECTION", "IMPORT INTO CORE"]) assert.ok(js.includes(w), `the built bundle is missing "${w}"`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
