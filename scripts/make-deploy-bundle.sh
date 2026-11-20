#!/usr/bin/env bash
# Puts everything the server needs in one folder to copy over (relay/README.md, trainworld/deploy/compose.yml):
#
#   scripts/make-deploy-bundle.sh --host trains.example.org --friends "alice,bob,carol" [--out DIR] [--no-build] [--show-codes]
#
#   --host     the address the game is served on (a DNS record for it must point at the server)
#   --friends  names for the invite codes, comma separated (labels, shown in the lobby as game hosts)
#   --out      the folder to write (default: ../trains-deploy, outside the repository)
#   --no-build use the game build already in trainworld/app/dist instead of building it again
#   --show-codes print each friend's invite code, the sign-in address and the cookie secret's place (default: not printed)
#
# The folder gets: compose.yml, relay/ (the relay's code and Dockerfile), dist/ (the built game), data-cache/ and a
# `.env` with random codes, cookie secret and a secret sign-in path. An existing `.env` is kept (only the host and
# the data version in it are updated), so a later run on the same folder updates the game without changing codes.
# Copy the folder to the server, then there: chown 1000:1000 data-cache && docker compose up -d --build

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

HOST=""; FRIENDS=""; OUT=""; BUILD=1; SHOW=0
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --friends) FRIENDS="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --show-codes) SHOW=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$HOST" ] || usage
OUT="${OUT:-../trains-deploy}"
VERSION=$(tr -d '\r\n' < trainworld/data-version.txt)

rand() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString(process.argv[2]))' "$1" "$2"; }

if [ "$BUILD" = 1 ]; then
  echo "== Building the game"
  (cd trainworld/app && npm run build)
fi
[ -d trainworld/app/dist ] || { echo "No trainworld/app/dist: run without --no-build."; exit 1; }

echo "== Assembling $OUT"
mkdir -p "$OUT/relay" "$OUT/dist" "$OUT/data-cache"
for f in server.mjs files.mjs package.json package-lock.json Dockerfile; do cp "trainworld/relay/$f" "$OUT/relay/$f"; done
rm -rf "$OUT/dist"
mkdir -p "$OUT/dist"
cp -r trainworld/app/dist/. "$OUT/dist/"
cp trainworld/deploy/compose.yml "$OUT/compose.yml"

ENV="$OUT/.env"
if [ -f "$ENV" ]; then
  echo "== Keeping the codes in the existing .env; updating the host and data version"
  sed -i "s|^TRAINS_HOST=.*|TRAINS_HOST=$HOST|; s|^TW_DATA_VERSION=.*|TW_DATA_VERSION=$VERSION|" "$ENV"
else
  [ -n "$FRIENDS" ] || { echo "A new .env needs --friends \"name,name\"."; exit 1; }
  invites=""
  IFS=',' read -ra names <<< "$FRIENDS"
  for n in "${names[@]}"; do
    n=$(printf '%s' "$n" | tr -d ' :,')
    [ -n "$n" ] || continue
    invites="${invites:+$invites,}$n:$(rand 12 base64url)"
  done
  [ -n "$invites" ] || { echo "No usable friend names in --friends."; exit 1; }
  {
    echo "TRAINS_HOST=$HOST"
    echo "TW_INVITES=$invites"
    echo "TW_SECRET=$(rand 48 hex)"
    echo "TW_LOGIN_PATH=/$(rand 9 hex)"
    echo "TW_DATA_VERSION=$VERSION"
  } > "$ENV"
  chmod 600 "$ENV" 2>/dev/null || true
  echo "== Wrote $ENV with random codes (it is not printed; keep it out of git)"
fi

cat > "$OUT/INSTALL.txt" <<'EOF'
On the server (Docker and the external network "proxy" that Traefik uses are assumed):

  scp -r trains-deploy you@server:/opt/trains        (or rsync, or any way you copy files)
  ssh you@server
  cd /opt/trains
  chown 1000:1000 data-cache
  docker compose up -d --build
  docker compose logs -f trains                      (it prints "trainsworld relay on ...")

Then open https://<host>/ : a plain 404 is right. https://<host>/<TW_LOGIN_PATH from .env> is the sign-in page.
Give each friend their own invite code (name:code pairs in TW_INVITES) and the sign-in address.

Updating the game later: run scripts/make-deploy-bundle.sh again with the same --out, copy the folder over, and
`docker compose up -d --build`. Taking a friend's access away: delete their pair in .env, then `docker compose up -d`.
EOF

echo
echo "Done: $OUT"
echo "  host:     https://$HOST/"
echo "  data:     $VERSION"
if [ "$SHOW" = 1 ]; then
  slug=$(grep '^TW_LOGIN_PATH=' "$ENV" | cut -d= -f2-)
  echo "  sign-in:  https://$HOST$slug"
  echo "  codes:"
  grep '^TW_INVITES=' "$ENV" | cut -d= -f2- | tr ',' '\n' | sed 's/^/    /'
else
  echo "  codes and the sign-in path are in $ENV (run again with --show-codes to print them)"
fi
