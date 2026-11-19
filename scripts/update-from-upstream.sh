#!/usr/bin/env bash
# Brings the original developer's new commits into this fork's `dev` branch and checks that everything still builds.
#
#   scripts/update-from-upstream.sh              fetch, merge, rebuild what changed, check
#   scripts/update-from-upstream.sh --build-only skip the merge (after you resolved conflicts and committed): just rebuild and check
#
# Stops at merge conflicts, listing the files; fix them, `git commit`, then run it again with --build-only.
# Needs node, npm, cargo and wasm-pack on the PATH (set CARGO_TARGET_DIR to a short path on Windows).
# Pushing and deploying are left to you: this only touches your working copy.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/circularsquare/trainsworld}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
WORK_BRANCH="${WORK_BRANCH:-dev}"
BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

say() { printf '\n== %s\n' "$*"; }

if [ "$BUILD_ONLY" = 0 ]; then
  [ "$(git branch --show-current)" = "$WORK_BRANCH" ] || { echo "Switch to the $WORK_BRANCH branch first (or set WORK_BRANCH)."; exit 1; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit or stash your changes first."; exit 1; }
  git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 || git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  git config rerere.enabled true      # git remembers how a conflict was resolved and reuses it next time

  say "Fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
  git fetch "$UPSTREAM_REMOTE"
  count=$(git rev-list --count "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
  if [ "$count" = 0 ]; then echo "Already up to date with $UPSTREAM_REMOTE/$UPSTREAM_BRANCH."; exit 0; fi
  echo "$count new upstream commit(s):"
  git log --oneline "HEAD..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" | head -20
  before=$(git rev-parse HEAD)

  say "Merging"
  if ! git merge --no-edit -m "Merge $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
    echo
    echo "Conflicts in:"
    git diff --name-only --diff-filter=U | sed 's/^/  /'
    echo "Resolve them, 'git add' the files, 'git commit', then run: scripts/update-from-upstream.sh --build-only"
    exit 2
  fi
  changed=$(git diff --name-only "$before" HEAD)
else
  changed=""   # unknown: rebuild everything
fi

touched() { [ "$BUILD_ONLY" = 1 ] || printf '%s\n' "$changed" | grep -Eq "$1"; }

say "Dependencies and wasm"
cd trainworld/app
if touched '^trainworld/app/package(-lock)?\.json$'; then npm install; fi
if touched '^trainworld/sim/'; then npm run wasm; else echo "(simulation unchanged, wasm not rebuilt)"; fi
if [ ! -d src/wasm/track ] || [ ! -d src/wasm/demand ]; then npm run wasm; fi

say "Type check"
npx tsc --noEmit
echo "types ok"

say "Relay tests"
cd ../relay
npm install --silent
npm test
cd ../..

say "Done"
version_now=$(tr -d '\r\n' < trainworld/data-version.txt)
echo "Data version is now: $version_now"
if [ "$BUILD_ONLY" = 0 ] && printf '%s\n' "$changed" | grep -q '^trainworld/data-version.txt$'; then
  echo "  -> it CHANGED: set TW_DATA_VERSION to this on the server when you deploy."
fi
cat <<'EOF'

Next:
  1. Open the game, host in one tab, join in another, make an edit on each side (co-op still works?).
  2. git push origin dev
  3. scripts/deploy.sh   (see its header)
EOF
