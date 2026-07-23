#!/usr/bin/env bash
# Forkwatch — production bring-up.
#
# Validates prerequisites, then builds and starts the public (Cloudflare Tunnel) stack defined in
# compose/docker-compose.prod.yml. Safe to re-run: `docker compose up -d` reconciles to the desired
# state, so this doubles as the "apply my changes / restart" script.
#
#   ./scripts/deploy-prod.sh            # build + up -d + status
#   ./scripts/deploy-prod.sh --logs     # ...then follow the node/app logs
#
set -euo pipefail

# Resolve repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="compose/docker-compose.prod.yml"
ENV_FILE="compose/.env"
ENV_EXAMPLE="compose/.env.prod.example"
SNAPSHOT="snapshots/utxo-840000.dat"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
die()   { red "ERROR: $*"; exit 1; }

# --- Preconditions -------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker not found on PATH."
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not available."

if [ ! -f "$ENV_FILE" ]; then
  red "Missing $ENV_FILE."
  echo "  Create it from the template and fill in the secrets, then re-run:"
  echo "      cp $ENV_EXAMPLE $ENV_FILE && \$EDITOR $ENV_FILE"
  exit 1
fi

# Read the handful of values we sanity-check WITHOUT sourcing the file. `source` executes it as
# shell, so an unquoted value containing a space — e.g. the shipped `FW_FORK_LABEL=Mandatory
# signaling` — aborts the deploy with "command not found", and any other content would run as code.
# Docker compose parses .env with its own non-shell rules and reads it directly, so such values are
# perfectly legal there; only this script needed to stop pretending the file is a shell script.
# The trailing `|| true` matters: under `set -euo pipefail` a key that is simply ABSENT makes grep
# exit non-zero, which would abort the whole script with no message instead of letting the explicit
# "is it empty?" checks below report which variable is missing.
envget() {
  grep -E "^[[:space:]]*${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true
}
FW_RPC_PASS=$(envget FW_RPC_PASS)
FW_CF_TUNNEL_TOKEN=$(envget FW_CF_TUNNEL_TOKEN)

[ "${FW_RPC_PASS:-}" = "change_me_before_deploying" ] && die "FW_RPC_PASS is still the placeholder in $ENV_FILE."
[ -z "${FW_RPC_PASS:-}" ] && die "FW_RPC_PASS is empty in $ENV_FILE."

# These values are committed in this repo's git history (commits 6775948, 93efdbd). History is
# public once pushed and cannot be un-published, so they are permanently burned — refuse to carry
# one into a public deployment even though the rpcauth change keeps it out of `ps`.
case "${FW_RPC_PASS:-}" in
  forkwars_mainnet|forkwars_regtest)
    die "FW_RPC_PASS is '${FW_RPC_PASS}', which is committed in this repo's git history and must
       never be used in production. Generate a fresh secret and set it in $ENV_FILE:
           openssl rand -base64 32" ;;
esac
[ "${FW_CF_TUNNEL_TOKEN:-}" = "paste_your_cloudflare_tunnel_token_here" ] && die "FW_CF_TUNNEL_TOKEN is still the placeholder in $ENV_FILE."
[ -z "${FW_CF_TUNNEL_TOKEN:-}" ] && die "FW_CF_TUNNEL_TOKEN is empty in $ENV_FILE."

if [ ! -f "$SNAPSHOT" ]; then
  die "Snapshot $SNAPSHOT is missing (~11 GB, not in git). Generate it with dumptxoutset from a
       trusted node, or copy it in, before first start. See $ENV_EXAMPLE."
fi

# --- Disk preflight ------------------------------------------------------------------------------
# prune=150000 is ~146 GiB of blocks PER NODE (~293 GiB for the pair), plus two chainstates, the
# ~11 GiB snapshot, the app's SQLite history and rotated logs. Running out mid-IBD — days in, with
# no warning — corrupts chainstate and costs a full resync, so fail here instead.
DOCKER_ROOT=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
REQUIRED_GB=${FW_MIN_DISK_GB:-500}
AVAIL_GB=$(df -PBG "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')
if [ -z "${AVAIL_GB:-}" ]; then
  red "WARNING: could not determine free space on $DOCKER_ROOT; ensure >= ${REQUIRED_GB} GB is available."
elif [ "$AVAIL_GB" -lt "$REQUIRED_GB" ]; then
  die "Only ${AVAIL_GB} GB free on $DOCKER_ROOT, but >= ${REQUIRED_GB} GB is needed (two pruned
       nodes at ~146 GiB each, plus chainstate, the snapshot, and the app DB). Attach a larger
       volume, or override the floor with FW_MIN_DISK_GB if you know better."
else
  green "Disk: ${AVAIL_GB} GB free on $DOCKER_ROOT (need >= ${REQUIRED_GB} GB)"
fi

# --- Build + up ----------------------------------------------------------------------------------
# Stamp the image with the commit being deployed (Dockerfile ARG GIT_SHA). A dirty tree is marked as
# such, because the resulting image then corresponds to no commit at all.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
git diff --quiet HEAD 2>/dev/null || GIT_SHA="${GIT_SHA}-dirty"
export GIT_SHA

bold "Building images (frontend + Rust backend + node images)... [commit $GIT_SHA]"
docker compose -f "$COMPOSE_FILE" build

bold "Starting the production stack..."
docker compose -f "$COMPOSE_FILE" up -d

# --- Verify what is actually running -------------------------------------------------------------
# The failure this catches: the build silently reuses a stale image (or the app never restarts), so
# the code you just reviewed and fixed is not the code serving traffic. Compare the commit reported
# by the LIVE container against the one we just built, rather than trusting image timestamps.
bold "Verifying the running container reports commit $GIT_SHA..."
running=""
for _ in $(seq 1 30); do
  running=$(docker exec fw-app-prod curl -fsS http://127.0.0.1:8080/health/live 2>/dev/null \
            | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p') || true
  [ -n "$running" ] && break
  sleep 2
done
if [ -z "$running" ]; then
  red "WARNING: could not read /health/live from fw-app-prod; verify the deploy manually."
elif [ "$running" != "$GIT_SHA" ]; then
  die "Deployed binary reports commit '$running' but '$GIT_SHA' was built. The app is running STALE
       code. Re-run with: docker compose -f $COMPOSE_FILE build --no-cache app && docker compose -f $COMPOSE_FILE up -d app"
else
  green "Verified: fw-app-prod is running commit $running"
fi

echo
green "Stack is up. Current status:"
docker compose -f "$COMPOSE_FILE" ps

cat <<'EOF'

Next:
  - Nodes now sync the real chain over Tor: headers first, then loadtxoutset at 840,000, then
    forward sync. This takes hours to a couple of days. The app serves a SYNCING screen meanwhile.
  - Watch progress:
      docker logs -f fw-core-prod
      docker exec fw-core-prod  bitcoin-cli -datadir=/data -rpcuser="$FW_RPC_USER" -rpcpassword="$FW_RPC_PASS" getblockchaininfo | grep -E "blocks|headers|pruneheight"
  - App readiness (green once ingest is fresh): the app's own /health/ready endpoint.
  - Your site is reachable at the Cloudflare public hostname you mapped to http://app:8080 as soon
    as the app container is up — no inbound ports are opened on this host.

EOF

if [ "${1:-}" = "--logs" ]; then
  bold "Following logs (Ctrl-C to stop; the stack keeps running)..."
  docker compose -f "$COMPOSE_FILE" logs -f
fi
