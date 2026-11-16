#!/usr/bin/env bash
# Builds the Windows test bundle (zip) ON LINUX from the committed HEAD of the current branch. Nothing in /opt/farmpilot-core is modified.
#   scripts/make-windows-bundle.sh [output-dir]      default output-dir: /var/tmp/farmpilot-core-bundle
# Needs: git, python3, curl, and the bench's own node at ./node/bin (used for npm and tsc/vite). Needs internet for nodejs.org and the npm registry.
# Refuses to run on a dirty tree, so dist/BUILD is the plain commit id (no "-dirty").
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; SRC=$PWD
export PATH="$SRC/node/bin:$PATH"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Working tree is not clean: commit first." >&2; exit 1; }
OUT="${1:-/var/tmp/farmpilot-core-bundle}"; SHA="$(git rev-parse --short HEAD)"; BRANCH="$(git rev-parse --abbrev-ref HEAD)"; DATE="$(date -u +%Y%m%d)"
NODE_MAJOR=22
mkdir -p "$OUT/cache"; W="$OUT/work-$SHA"; rm -rf "$W"; mkdir -p "$W/FarmPilotCore"; STAGE="$W/FarmPilotCore"

echo "==> Windows x64 Node $NODE_MAJOR (latest LTS from nodejs.org)"
VER="$(curl -fsS https://nodejs.org/dist/index.json | python3 -c "import json,sys; print([x['version'] for x in json.load(sys.stdin) if x['version'].startswith('v$NODE_MAJOR.') and x['lts']][0])")"
ZIP="node-$VER-win-x64.zip"
[ -f "$OUT/cache/$ZIP" ] || curl -fsS -o "$OUT/cache/$ZIP" "https://nodejs.org/dist/$VER/$ZIP"
WANT="$(curl -fsS "https://nodejs.org/dist/$VER/SHASUMS256.txt" | awk -v f="$ZIP" '$2==f{print $1}')"; GOT="$(sha256sum "$OUT/cache/$ZIP" | awk '{print $1}')"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "SHA-256 mismatch for $ZIP" >&2; exit 1; }; echo "    $ZIP sha256 ok"

echo "==> clean export of $BRANCH @ $SHA"
git archive HEAD | tar -x -C "$W/src.tmp" 2>/dev/null || { mkdir -p "$W/src.tmp"; git archive HEAD | tar -x -C "$W/src.tmp"; }
cd "$W/src.tmp"
echo "==> build (dev dependencies, then discarded)"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null; npm --prefix web ci --ignore-scripts --no-audit --no-fund >/dev/null; npm run build >/dev/null
echo "$SHA" > dist/BUILD
echo "==> production node_modules (all platform prebuilds stay inside better-sqlite3 and @serialport/bindings-cpp)"
rm -rf node_modules; npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
for f in node_modules/better-sqlite3/prebuilds/win32-x64.node node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node; do [ -f "$f" ] || { echo "missing Windows binary: $f" >&2; exit 1; }; done

echo "==> assemble"
cp -r dist "$STAGE/dist"; mkdir -p "$STAGE/web"; cp -r web/dist "$STAGE/web/dist"; cp -r config "$STAGE/config"; cp -r node_modules "$STAGE/node_modules"; cp package.json "$STAGE/"
mkdir -p "$STAGE/node"; python3 - "$OUT/cache/$ZIP" "$STAGE/node" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); top = z.namelist()[0].split("/")[0]
for n in ("node.exe", "LICENSE"): open(f"{sys.argv[2]}/{n}", "wb").write(z.read(f"{top}/{n}"))
PY
crlf() { sed 's/$/\r/' "$1" > "$2"; }          # .cmd and text files with Windows line endings
crlf start-core.cmd "$STAGE/start-core.cmd"; crlf deploy/windows/check.cmd "$STAGE/check.cmd"; crlf deploy/windows/README.md "$STAGE/README.md"; cp deploy/windows/check.mjs "$STAGE/check.mjs"
printf 'Farm-Pilot CORE Windows test bundle\r\nbuild: %s (%s)\r\nnode:  %s win-x64\r\nbuilt: %s UTC\r\n' "$SHA" "$BRANCH" "$VER" "$(date -u '+%F %T')" > "$STAGE/VERSION.txt"

FINAL="$OUT/FarmPilotCore-windows-$SHA-$DATE.zip"; rm -f "$FINAL"
python3 - "$W" "$FINAL" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for d, _, fs in os.walk(os.path.join(root, "FarmPilotCore")):
        for f in sorted(fs): p = os.path.join(d, f); z.write(p, os.path.relpath(p, root))
PY
rm -rf "$W"; sha256sum "$FINAL" > "$FINAL.sha256"; ls -l "$FINAL"; cat "$FINAL.sha256"
