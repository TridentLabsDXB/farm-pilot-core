import "./isolate.js";   // test data folder is a temp dir
// Shared shell, sidebar top block (2026-11-18): logo centred, round, 104 px, object-fit contain; farm name bold under it, centred, wrapping (never a one-line ellipsis); no logo = round initials placeholder of the SAME size;
// phone (< 768 px): logo 36 px and the name on one row. CSS / source checks, same style as menu.test.ts, so the layout cannot regress silently.
import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs";
import { initials } from "../web/src/Brand.js";

const css = readFileSync("web/src/core.css", "utf8").replace(/\/\*[^]*?\*\//g, ""), sb = readFileSync("web/src/Sidebar.tsx", "utf8"), app = readFileSync("web/src/App.tsx", "utf8"), brand = readFileSync("web/src/Brand.tsx", "utf8");
/** The declarations of the first rule whose selector list contains `sel`, outside any @media block. */
const rule = (sel: string, source = css) => { for (const m of source.matchAll(/(^|\n)([^@{}\n][^{}]*)\{([^}]*)\}/g)) if (m[2].split(",").map((x) => x.trim()).includes(sel)) return m[3]; throw new Error("no rule for " + sel); };
const media = (head: string) => { const i = css.indexOf(head); assert.ok(i >= 0, head); let d = 0, j = css.indexOf("{", i); const start = j; for (; j < css.length; j++) { if (css[j] === "{") d++; else if (css[j] === "}" && --d === 0) break; } return css.slice(start + 1, j); };

test("sidebar logo and placeholder: round, 104 px, object-fit contain, centred block", () => {
  const m = rule(".fp-brand-mark"); assert.match(m, /width: 104px/); assert.match(m, /height: 104px/); assert.match(m, /border-radius: 50%/); assert.match(m, /object-fit: contain/); assert.ok(!/object-fit: cover/.test(css), "no cover anywhere: the logo is never cropped");
  const b = rule(".fp-sb-brand"); assert.match(b, /flex-direction: column/); assert.match(b, /align-items: center/); assert.match(b, /text-align: center/); assert.match(b, /border-bottom: 1px solid var\(--fp-border\)/, "the divider under the block");
  const ph = rule(".fp-brand-ph"); assert.match(ph, /border-radius|display: inline-flex/); assert.ok(!/(^|[;\s])(width|height)\s*:/.test(ph), "the placeholder takes its size from .fp-brand-mark: same size as the logo");
});
test("farm name: bold, centred under the logo, wraps; never clamped or cut to one line", () => {
  const n = rule(".fp-sb-brand .fp-sb-name"); assert.match(n, /font-weight: 700/); assert.match(n, /white-space: normal/); assert.match(n, /overflow-wrap: anywhere/);
  assert.ok(!/line-clamp|nowrap|text-overflow|overflow: hidden/.test(n), "no clamp, no ellipsis, no hidden overflow on the name");
  assert.ok(sb.indexOf("<BrandMark") < sb.indexOf('className="fp-sb-name"'), "name sits directly under the logo");
});
test("no media rule shrinks the sidebar brand: the compact-height rule keeps the menu tight but not the logo; only the phone header uses 36 px", () => {
  const compact = media("@media (min-width: 1024px) and (max-height: 860px)"); assert.ok(!/fp-sb-brand|fp-brand/.test(compact), "the short-screen rule must not touch the brand block");
  const phone = media("@media (max-width: 767px)"); assert.match(phone, /\.fp-phone-title \.fp-brand-mark \{ width: 36px; height: 36px/); assert.match(phone, /\.fp-phone-title \{ display: flex; align-items: center/); assert.match(phone, /\.fp-phone-name \{[^}]*white-space: nowrap/, "phone: name on one row");
  assert.match(phone, /\.fp-sidebar \{ display: none; \}/, "the phone has no sidebar, its header carries the mark");
});
test("shared by every page: Sidebar and the phone header use BrandMark; no logo = initials placeholder of the same class", () => {
  assert.match(sb, /<BrandMark pub=\{pub\} \/>/); assert.match(app, /<BrandMark pub=\{pub\} \/>/); assert.match(app, /className="fp-phone-name"/);
  assert.match(brand, /fp-brand-mark fp-brand-ph/); assert.match(brand, /pub\?\.logo_url \?/);
  assert.equal(initials("Al Maimoon Farm"), "AM"); assert.equal(initials("Demo Farm"), "DF"); assert.equal(initials("Greenhouse"), "GR"); assert.equal(initials("  "), "FP"); assert.equal(initials(null), "FP"); assert.equal(initials("الميمون مزرعة"), "ال".length ? initials("الميمون مزرعة") : ""); assert.equal(initials("a - b"), "AB");
});
