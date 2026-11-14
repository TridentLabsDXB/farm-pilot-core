#!/usr/bin/env bash
# Same behaviour as the main Farm-Pilot push-to-github.sh. Usage: ./push-to-github.sh [--all] "message"
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESSAGE="${1:-Update $(date '+%Y-%m-%d %H:%M')}"
STAGE_ALL=0
if [ "${1:-}" = "--all" ]; then STAGE_ALL=1; shift; MESSAGE="${1:-Update $(date '+%Y-%m-%d %H:%M')}"; fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> Repo: $PWD  (branch: $BRANCH)"
if [ "$STAGE_ALL" -eq 1 ]; then echo "==> Staging ALL changes (--all)..."; git add .
else
  LEFTOVER="$(git status --porcelain | grep -v '^[MADRC]' || true)"
  [ -z "$LEFTOVER" ] || { echo "==> Not staged (use 'git add <file>' or --all):"; echo "$LEFTOVER"; }
fi
if git diff --cached --quiet; then
  echo "==> Nothing staged -- nothing to commit."
  AHEAD="$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 1)"
  [ "$AHEAD" -ne 0 ] || exit 0
  echo "==> $BRANCH is ahead of its upstream -- pushing."
else
  echo "==> Committing: $MESSAGE"; git commit -m "$MESSAGE"
fi
echo "==> Pushing $BRANCH to GitHub..."; git push --set-upstream origin "$BRANCH"; echo "==> Done."
