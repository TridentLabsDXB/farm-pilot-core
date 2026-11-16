// Bundles the two text files the About page shows, so no network is needed at run time:
//   web/public/THIRD-PARTY-NOTICES.txt  generated from the PRODUCTION dependencies (server and web), name, version, licence, licence text
//   web/public/CHANGELOG.md             copy of CHANGELOG.md
// Plain Node (also runs on Windows). Usage: node scripts/gen-notices.mjs [outDir]   (default web/public). Runs first in `npm run build`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rd = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const licenceText = (dir) => { try { const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|$)/i.test(n)); return f ? rd(join(dir, f)).trim() : ""; } catch { return ""; } };
/** Production packages of one lock file that are installed under `root` (dev-only packages and uninstalled optional ones are skipped). */
export function prodPackages(root) {
  const lock = JSON.parse(rd(join(root, "package-lock.json")) ?? "{}"), out = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || meta.dev || !path.includes("node_modules/")) continue;
    const dir = join(root, path), pj = rd(join(dir, "package.json")); if (!pj) continue;          // optional package for another platform: not installed
    const p = JSON.parse(pj), lic = typeof p.license === "string" ? p.license : p.license?.type ?? (p.licenses?.[0]?.type ?? "UNKNOWN");
    out.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, license: lic, text: licenceText(dir) });
  }
  return [...out.values()];
}
export function buildNotices(roots) {
  const all = new Map(); for (const r of roots) for (const p of prodPackages(r)) all.set(`${p.name}@${p.version}`, p);
  const list = [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const head = "FARM-PILOT CORE: third-party notices\n\nCORE includes the open source packages below (production dependencies of the server and the web app). Each keeps its own licence.\n\n";
  return head + list.map((p) => `${"=".repeat(72)}\n${p.name} ${p.version}   [${p.license}]\n${"=".repeat(72)}\n${p.text || "(licence file not included in the package; see the package's registry page for its " + p.license + " licence)"}\n`).join("\n") + `\n${list.length} packages.\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = resolve(fileURLToPath(import.meta.url), "..", ".."), out = resolve(process.argv[2] || join(base, "web", "public"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), buildNotices([base, join(base, "web")]));
  if (existsSync(join(base, "CHANGELOG.md"))) copyFileSync(join(base, "CHANGELOG.md"), join(out, "CHANGELOG.md"));
  console.log("notices written to", out);
}
