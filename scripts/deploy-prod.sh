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

# Load the env so we can sanity-check the required secrets before invoking compose.
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

[ "${FW_RPC_PASS:-}" = "change_me_before_deploying" ] && die "FW_RPC_PASS is still the placeholder in $ENV_FILE."
[ -z "${FW_RPC_PASS:-}" ] && die "FW_RPC_PASS is empty in $ENV_FILE."
[ "${FW_CF_TUNNEL_TOKEN:-}" = "paste_your_cloudflare_tunnel_token_here" ] && die "FW_CF_TUNNEL_TOKEN is still the placeholder in $ENV_FILE."
[ -z "${FW_CF_TUNNEL_TOKEN:-}" ] && die "FW_CF_TUNNEL_TOKEN is empty in $ENV_FILE."

if [ ! -f "$SNAPSHOT" ]; then
  die "Snapshot $SNAPSHOT is missing (~11 GB, not in git). Generate it with dumptxoutset from a
       trusted node, or copy it in, before first start. See $ENV_EXAMPLE."
fi

# --- Build + up ----------------------------------------------------------------------------------
bold "Building images (frontend + Rust backend + node images)..."
docker compose -f "$COMPOSE_FILE" build

bold "Starting the production stack..."
docker compose -f "$COMPOSE_FILE" up -d

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
