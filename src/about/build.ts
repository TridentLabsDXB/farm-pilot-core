// Version and build label, ONE source for /api/health, /api/about and (through them) the login footer and the About page.
// dist/BUILD.json is written by scripts/build-stamp.mjs at deploy time: { build, released, dirty }. dist/BUILD (one line) is the older form and is still read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo { version: string; build: string; released: string | null; dirty: boolean; label: string; }
const root = () => join(dirname(fileURLToPath(import.meta.url)), "..");        // dist/ (production) or src/ (dev): BUILD files sit next to the server code

/** "v0.1.0 · build d4d82c4" -- the exact text after "FARM-PILOT CORE · " in the login footer and in the About identity card. */
export const buildLabel = (version: string, build: string) => [version && `v${version}`, build && build !== "unknown" && `build ${build}`].filter(Boolean).join(" · ");

export function readBuild(dir = root(), pkgDir = join(dir, "..")): BuildInfo {
  let version = ""; try { version = String(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? ""); } catch { /* unreadable */ }
  let build = "unknown", released: string | null = null;
  try { const j = JSON.parse(readFileSync(join(dir, "BUILD.json"), "utf8")); if (typeof j.build === "string" && j.build) build = j.build; if (typeof j.released === "string") released = j.released; }
  catch { try { build = readFileSync(join(dir, "BUILD"), "utf8").trim() || "unknown"; } catch { /* dev run: no stamp */ } }
  return { version, build, released, dirty: /-dirty$/i.test(build), label: buildLabel(version, build) };
}
