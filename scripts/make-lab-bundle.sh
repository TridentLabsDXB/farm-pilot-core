#!/usr/bin/env bash
# Builds the Windows LAB bundle (zip) ON LINUX from the committed HEAD of the current branch. Nothing in /opt/farmpilot-core is modified.
#   scripts/make-lab-bundle.sh [output-dir]      default output-dir: /var/tmp/farmpilot-core-bundle
# Result: farmpilot-core-lab-<version>-<buildid>-win-x64.zip whose TOP FOLDER is FarmPilot-Core\ (unpack at C:\ gives C:\FarmPilot-Core\app).
# Needs: git, python3, curl, and the bench's own node at ./node/bin (npm, tsc, vite). Needs internet for nodejs.org and the npm registry.
# Refuses to run on a dirty tree, so the build id is the plain commit id (no "-dirty"). The stamp is NOT a release: dev-1 is trusted (see src/licence/keys.ts).
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; SRC=$PWD
export PATH="$SRC/node/bin:$PATH"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Working tree is not clean: commit first." >&2; exit 1; }
OUT="${1:-/var/tmp/farmpilot-core-bundle}"; SHA="$(git rev-parse --short HEAD)"; BRANCH="$(git rev-parse --abbrev-ref HEAD)"
VERSION="$(node -p "require('./package.json').version")"; NODE_MAJOR=22
mkdir -p "$OUT/cache"; W="$OUT/work-$SHA"; rm -rf "$W"; mkdir -p "$W"; TOP="$W/FarmPilot-Core"; APP="$TOP/app"; mkdir -p "$APP"

echo "==> Windows x64 Node $NODE_MAJOR (latest LTS from nodejs.org)"
VER="$(curl -fsS https://nodejs.org/dist/index.json | python3 -c "import json,sys; print([x['version'] for x in json.load(sys.stdin) if x['version'].startswith('v$NODE_MAJOR.') and x['lts']][0])")"
ZIP="node-$VER-win-x64.zip"
[ -f "$OUT/cache/$ZIP" ] || curl -fsS -o "$OUT/cache/$ZIP" "https://nodejs.org/dist/$VER/$ZIP"
WANT="$(curl -fsS "https://nodejs.org/dist/$VER/SHASUMS256.txt" | awk -v f="$ZIP" '$2==f{print $1}')"; GOT="$(sha256sum "$OUT/cache/$ZIP" | awk '{print $1}')"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "SHA-256 mismatch for $ZIP" >&2; exit 1; }; echo "    $ZIP sha256 ok"

echo "==> clean export of $BRANCH @ $SHA"
mkdir -p "$W/src.tmp"; git archive HEAD | tar -x -C "$W/src.tmp"; cd "$W/src.tmp"
echo "==> build (dev dependencies, then discarded)"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null; npm --prefix web ci --ignore-scripts --no-audit --no-fund >/dev/null; npm run build >/dev/null
# Build stamp, same format as scripts/build-stamp.mjs (the export has no .git): NOT a release, so dev-1 is trusted. released = build date.
node --input-type=module -e "import { makeStamp } from './scripts/build-stamp.mjs'; import { writeFileSync } from 'node:fs'; const s = makeStamp({ hash: '$SHA', dirty: false, release: false }); writeFileSync('dist/BUILD', s.build + '\n'); writeFileSync('dist/BUILD.json', JSON.stringify(s) + '\n'); console.log('    stamp', JSON.stringify(s));"
echo "==> production node_modules, Windows binaries only"
rm -rf node_modules; npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
SQL=node_modules/better-sqlite3/prebuilds/win32-x64.node; SER="node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node"
for f in "$SQL" "$SER"; do [ -f "$f" ] || { echo "missing Windows binary: $f" >&2; exit 1; }; done
find node_modules/better-sqlite3/prebuilds -type f ! -name win32-x64.node -delete
find node_modules/@serialport/bindings-cpp/prebuilds -mindepth 1 -maxdepth 1 ! -name win32-x64 -exec rm -rf {} +
rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src node_modules/better-sqlite3/binding.gyp node_modules/@serialport/bindings-cpp/src node_modules/@serialport/bindings-cpp/binding.gyp 2>/dev/null || true
find node_modules -name "*.map" -type f -delete; find dist web/dist -name "*.map" -type f -delete

echo "==> assemble"
cp -r dist "$APP/dist"; mkdir -p "$APP/web"; cp -r web/dist "$APP/web/dist"; cp -r config "$APP/config"; cp -r node_modules "$APP/node_modules"; cp package.json "$APP/"
mkdir -p "$APP/node"; python3 - "$OUT/cache/$ZIP" "$APP/node" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); top = z.namelist()[0].split("/")[0]
for n in ("node.exe", "LICENSE"): open(f"{sys.argv[2]}/{n}", "wb").write(z.read(f"{top}/{n}"))
PY
crlf() { sed 's/$/\r/' "$1" > "$2"; }          # .cmd and text files with Windows line endings
crlf start-core.cmd "$APP/start-core.cmd"; crlf deploy/windows/check.cmd "$APP/check.cmd"; crlf deploy/windows/upgrade.cmd "$APP/upgrade.cmd"; crlf deploy/windows/serial-probe.cmd "$APP/serial-probe.cmd"
cp deploy/windows/check.mjs deploy/windows/urls.mjs deploy/windows/upgrade.mjs deploy/windows/serial-probe.mjs "$APP/"
BUILD="$(cat dist/BUILD)"; DATE="$(node -p "require('./dist/BUILD.json').released")"
crlf deploy/windows/core.env.example "$TOP/core.env.example"
{ cat deploy/windows/README-LAB.txt; printf '\nBUILD\n    version %s, build %s (%s), build date %s, Node %s win-x64, NOT a release build (dev-1 licence key trusted)\n' "$VERSION" "$BUILD" "$BRANCH" "$DATE" "$VER"; } | sed 's/$/\r/' > "$TOP/README-LAB.txt"
cd "$SRC"

echo "==> verify"
FAIL=0
echo "    PE checks (x86-64, imports, AVX marker)"; python3 scripts/verify-pe.py "$W/src.tmp/$SQL" "$W/src.tmp/$SER" "$APP/node/node.exe" | sed 's/^/      /' || FAIL=1
if grep -rIl "FarmPilotCore" "$TOP" 2>/dev/null | grep -q .; then echo "    leftover FarmPilotCore path in:"; grep -rIl "FarmPilotCore" "$TOP"; FAIL=1; else echo "    no leftover \"FarmPilotCore\" path in any text file"; fi
for f in dist/index.js dist/platform.js web/dist/index.html config/gateway-thingsend.yaml node/node.exe node_modules/better-sqlite3/prebuilds/win32-x64.node start-core.cmd check.cmd serial-probe.cmd serial-probe.mjs upgrade.cmd upgrade.mjs check.mjs urls.mjs dist/BUILD dist/BUILD.json package.json; do [ -f "$APP/$f" ] || { echo "    MISSING app/$f"; FAIL=1; }; done
for f in README-LAB.txt core.env.example; do [ -f "$TOP/$f" ] || { echo "    MISSING $f"; FAIL=1; }; done
for bad in tools test .git; do [ ! -e "$APP/$bad" ] || { echo "    unexpected app/$bad"; FAIL=1; }; done
[ -z "$(find "$APP" -name '*.map' -print -quit)" ] || { echo "    source maps left in the bundle"; FAIL=1; }
head -c 300 "$APP/start-core.cmd" | grep -q $'\r' || { echo "    start-core.cmd is not CRLF"; FAIL=1; }
[ "$FAIL" = 0 ] || { echo "VERIFY FAILED" >&2; exit 1; }

FINAL="$OUT/farmpilot-core-lab-$VERSION-$SHA-win-x64.zip"; rm -f "$FINAL" "$FINAL.sha256"
python3 - "$W" "$FINAL" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for d, _, fs in os.walk(os.path.join(root, "FarmPilot-Core")):
        for f in sorted(fs): p = os.path.join(d, f); z.write(p, os.path.relpath(p, root))
PY
python3 - "$FINAL" <<'PY'
import sys, zipfile
names = zipfile.ZipFile(sys.argv[1]).namelist(); tops = {n.split("/")[0] for n in names}
assert tops == {"FarmPilot-Core"}, tops; assert "FarmPilot-Core/app/start-core.cmd" in names and "FarmPilot-Core/app/node/node.exe" in names
print("    zip top folder:", tops.pop(), "|", len(names), "files")
PY
rm -rf "$W"; chmod 644 "$FINAL"; (cd "$OUT" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256"); chmod 644 "$FINAL.sha256"; ls -l "$FINAL"; cat "$FINAL.sha256"
