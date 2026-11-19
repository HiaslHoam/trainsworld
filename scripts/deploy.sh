#!/usr/bin/env bash
# Builds the game and puts it on the server (the relay in trainworld/relay serves it; see its README).
#
#   DEPLOY_TARGET=user@server:/opt/trains scripts/deploy.sh [--relay] [--dry-run]
#
#   (default)   build the game, copy app/dist to $DEPLOY_TARGET/dist: players get it on their next page load
#   --relay     also copy the relay's code to $DEPLOY_TARGET/relay and restart it (when relay/ changed)
#   --dry-run   build nothing new, copy nothing: show what would be copied
#
# Settings (environment):
#   DEPLOY_TARGET    ssh target and folder on the server, e.g. you@server:/opt/trains (required)
#   DEPLOY_RESTART   the command run on the server in that folder to restart the relay
#                    (default: docker compose up -d --build trains)
#
# Needs ssh and rsync on this machine (Git for Windows has ssh but no rsync: run this from WSL) and the same
# toolchain as scripts/update-from-upstream.sh. The relay does not need a restart for a new game build.
# A game build is "another version" to co-op: players in a game should reload after you deploy (a guest of another
# build than its host is refused with a message).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TARGET="${DEPLOY_TARGET:-}"
[ -n "$TARGET" ] || { echo "Set DEPLOY_TARGET=user@server:/path (see the header)."; exit 1; }
HOST="${TARGET%%:*}"; DIR="${TARGET#*:}"
RESTART="${DEPLOY_RESTART:-docker compose up -d --build trains}"
RELAY=0; DRY=0
for a in "$@"; do
  case "$a" in
    --relay) RELAY=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option $a"; exit 1 ;;
  esac
done
RSYNC=(rsync -az --delete --delay-updates)
[ "$DRY" = 1 ] && RSYNC+=(--dry-run --itemize-changes)

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Warning: you have uncommitted changes; they will be in this build."
fi

if [ "$DRY" = 0 ]; then
  echo "== Building"
  (cd trainworld/app && npm run build)
fi
[ -d trainworld/app/dist ] || { echo "No trainworld/app/dist: run without --dry-run first."; exit 1; }

echo "== Copying the game to $TARGET/dist"
"${RSYNC[@]}" trainworld/app/dist/ "$TARGET/dist/"

if [ "$RELAY" = 1 ]; then
  echo "== Copying the relay to $TARGET/relay"
  "${RSYNC[@]}" --exclude node_modules --exclude data-cache --exclude test.mjs \
    trainworld/relay/ "$TARGET/relay/"
  if [ "$DRY" = 0 ]; then
    echo "== Restarting the relay ($RESTART)"
    ssh "$HOST" "cd '$DIR' && $RESTART"
  fi
fi

echo
echo "Data version of this build: $(tr -d '\r\n' < trainworld/data-version.txt)   (the server's TW_DATA_VERSION must match it)"
echo "Done."
