import "./isolate.js";   // test data folder is a temp dir, never /var/lib/farmpilot-core (see isolate.ts)
// 2026-11-16 -- login page uses the Farm Pilot CORE badge: assets exist, alt text kept, no separate title, sizes 220 / 180 px, behaviours still wired.
import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync, statSync } from "node:fs";
const login = readFileSync("web/src/Login.tsx", "utf8"), css = readFileSync("web/src/core.css", "utf8");
test("login logo: files, alt text, no separate FARM-PILOT CORE title, 220 px desktop / 180 px phone, local assets only", () => {
  for (const f of ["farm-pilot-core-logo.png", "farm-pilot-core-logo-512.webp", "farm-pilot-core-logo-1024.webp", "farm-pilot-core-logo-512.png"]) assert.ok(statSync("web/public/brand/" + f).size > 10_000, f);
  const head = readFileSync("web/public/brand/farm-pilot-core-logo.png").subarray(0, 8); assert.equal(head.toString("hex"), "89504e470d0a1a0a");
  assert.match(login, /alt="Farm Pilot CORE"/); assert.ok(!/<h1>/.test(login), "no separate title under the badge"); assert.match(login, /\{farm \|\| SUBTITLE\}/);
  assert.match(css, /\.fp-login-logo \{ width: 220px/); assert.match(css, /max-width: 767px\) \{ \.fp-login-logo \{ width: 180px/); assert.ok(!/https?:\/\//.test(login.replace(/\/\/.*$/gm, "")), "no external requests");
  for (const k of ["setShow", "CAPS LOCK IS ON", "TOO MANY ATTEMPTS", "WRONG USER OR PASSWORD", "retry-after"]) assert.ok(login.includes(k), k);
});

test("login credit line: exact text, 'Trident Labs' stronger, between the card and the build footer, plain text (no link, no flag emoji, no external request), footer unchanged", () => {
  assert.match(login, /<p className="fp-login-credit">Engineered in the UAE by <strong>Trident Labs<\/strong><\/p>/);
  const i = login.indexOf("</form>"), c = login.indexOf('className="fp-login-credit"'), f = login.indexOf('<footer className="fp-login-foot">'); assert.ok(i < c && c < f, "order: card, credit, footer");
  assert.match(login, /<footer className="fp-login-foot">FARM-PILOT CORE\{version \? ` · \$\{version\}` : ""\}<\/footer>/);
  const line = login.slice(c, login.indexOf("</p>", c)); assert.ok(!/<a |href|https?:|["“”]/.test(line.replace('className="fp-login-credit"', "")), "no link, no quotation marks"); assert.ok(!/[\u{1F1E6}-\u{1F1FF}]/u.test(login), "no flag emoji");
  assert.match(css, /\.fp-login-credit \{[^}]*font-size: 13px[^}]*letter-spacing: \.08em[^}]*color: var\(--fp-muted\)/); assert.match(css, /\.fp-login-credit strong \{ font-weight: 700; color: var\(--fp-text\)/);
});
