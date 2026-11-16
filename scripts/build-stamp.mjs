// Build stamp for dist/: BUILD (one line, as before) and BUILD.json ({ build, released, dirty }). Plain Node, so it also runs on Windows.
//   node scripts/build-stamp.mjs [--release] [outDir]
// --release (or RELEASE=1): a dirty work tree is an ERROR, because a release build must never carry "-dirty" (About spec, Build and version).
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function makeStamp({ hash, dirty, release, now = new Date() }) {
  if (release && dirty) throw new Error("RELEASE build refused: the work tree has uncommitted changes (would be stamped -dirty). Commit or stash, then build again.");
  return { build: (hash || "unknown") + (dirty ? "-dirty" : ""), released: now.toISOString().slice(0, 10), dirty: !!dirty };
}
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), release = args.includes("--release") || process.env.RELEASE === "1", out = args.find((a) => !a.startsWith("--")) || "dist";
  try {
    const s = makeStamp({ hash: git("rev-parse", "--short", "HEAD"), dirty: !!git("status", "--porcelain", "--untracked-files=no"), release });
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, "BUILD"), s.build + "\n"); writeFileSync(join(out, "BUILD.json"), JSON.stringify(s) + "\n"); console.log("build stamp:", s.build, s.released);
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
