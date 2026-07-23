#!/usr/bin/env bash
# Forkwatch regtest control surface. One place to tweak the simulated chain and rebuild to it.
#
#   sg docker -c 'bash scripts/regtest.sh reset'                    # wipe + rebuild to compose/regtest.env
#   sg docker -c 'bash scripts/regtest.sh reset LEAD_BLOCKS=20'     # ...with one-off overrides
#   sg docker -c 'bash scripts/regtest.sh status'                   # where is the chain now
#   sg docker -c 'bash scripts/regtest.sh fork-now'                 # stop waiting, fork this second
#
# Persistent parameters live in compose/regtest.env. Overrides passed as KEY=VALUE args are saved
# into compose/.regtest.runtime.env alongside the derived FORK_AT_HEIGHT, so `up`/`restart` after a
# reset reuse exactly the state you built.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
COMPOSE_FILE="$HERE/compose/docker-compose.regtest.yml"
PARAMS="$HERE/compose/regtest.env"
RUNTIME="$HERE/compose/.regtest.runtime.env"

# Build provenance for the app image (Dockerfile ARG GIT_SHA -> /health/live .commit), so a regtest
# container can be tied to a commit the same way prod is. Dirty trees are marked.
GIT_SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$HERE" diff --quiet HEAD 2>/dev/null || GIT_SHA="${GIT_SHA}-dirty"
export GIT_SHA

dc() { docker compose --env-file "$PARAMS" --env-file "$RUNTIME" -f "$COMPOSE_FILE" "$@"; }
C()  { docker exec fw-core  bitcoin-cli -datadir=/data "$@"; }
K()  { docker exec fw-knots bitcoin-cli -datadir=/data "$@"; }

touch "$RUNTIME"

# Effective value of a parameter: runtime override wins over compose/regtest.env.
param() {
  local key="$1" v=""
  v=$(grep -E "^${key}=" "$RUNTIME" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  [ -n "$v" ] || v=$(grep -E "^${key}=" "$PARAMS" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  printf '%s' "$v"
}

# Replace (or append) KEY=VALUE in the runtime override file.
put() {
  local key="${1%%=*}" line="$1"
  grep -vE "^${key}=" "$RUNTIME" > "$RUNTIME.tmp" 2>/dev/null || true
  printf '%s\n' "$line" >> "$RUNTIME.tmp"
  mv "$RUNTIME.tmp" "$RUNTIME"
}

wait_healthy() {
  for n in "$@"; do
    printf '  waiting for %s' "$n"
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$n" 2>/dev/null)" = "healthy" ]; do
      printf '.'; sleep 1
    done
    printf ' healthy\n'
  done
}

cmd_reset() {
  # One-off overrides: any KEY=VALUE arg. They persist in the runtime file for later `up`s.
  : > "$RUNTIME"
  for kv in "$@"; do
    case "$kv" in
      *=*) put "$kv"; echo "[reset] override $kv";;
      *) echo "unknown argument: $kv (expected KEY=VALUE)"; exit 1;;
    esac
  done

  local lead spacing epochs retarget knots_per_100
  lead=$(param LEAD_BLOCKS);        spacing=$(param BLOCK_SPACING_SECS)
  epochs=$(param VISIBLE_EPOCHS);   retarget=$(param RETARGET_INTERVAL)
  knots_per_100=$(param KNOTS_PER_100)

  echo "### wiping regtest chain + app db ###"
  dc down -v >/dev/null 2>&1 || true

  # Build every image UP FRONT. Building app/miner later would re-tag the node images too and
  # recreate fw-core/fw-knots mid-reset — restarting bitcoind under the chain we just built, which
  # among other things drops the loaded wallet holding the fork's funding coins.
  echo "### building images ###"
  dc build >/dev/null

  echo "### starting nodes ###"
  dc up -d --no-build core knots >/dev/null
  wait_healthy fw-core fw-knots

  echo "### building chain (RDTS activation, then $((epochs * retarget)) blocks of mainnet-shaped history) ###"
  local out height fork floor
  out=$(BLOCK_SPACING_SECS="$spacing" LEAD_BLOCKS="$lead" VISIBLE_EPOCHS="$epochs" \
        RETARGET_INTERVAL="$retarget" KNOTS_PER_100="$knots_per_100" \
        python3 "$HERE/scripts/regtest_build.py" | tee /dev/stderr)
  height=$(printf '%s' "$out" | grep -E '^HEIGHT=' | tail -1 | cut -d= -f2)
  fork=$(printf '%s' "$out" | grep -E '^FORK_AT_HEIGHT=' | tail -1 | cut -d= -f2)
  floor=$(printf '%s' "$out" | grep -E '^FLOOR_HEIGHT=' | tail -1 | cut -d= -f2)
  [ -n "$height" ] && [ -n "$fork" ] && [ -n "$floor" ] || { echo "chain build failed"; exit 1; }

  # Only knowable post-build: RDTS activation lands wherever it lands, and floor/fork are the
  # retarget boundaries above it.
  put "FORK_AT_HEIGHT=$fork"
  put "FLOOR_HEIGHT=$floor"

  echo "### starting app + miner ###"
  dc up -d --no-build app miner >/dev/null

  cat <<EOF

====================================================================
 Regtest rebuilt as a scaled mainnet mirror.   Open:  http://localhost:8080

   tip now         $height
   fork at         $fork   ($((fork - height)) blocks, ~$(( (fork - height) * spacing / 60 )) min at ${spacing}s/block)
   app floor       $floor   (visible window ${epochs} x ${retarget} blocks)
   knots hashrate  ${knots_per_100}%

 The app backfills the window from the nodes over the next few minutes.

 Watch:   sg docker -c 'docker logs -f fw-miner'
 Status:  sg docker -c 'bash scripts/regtest.sh status'
 Sooner:  sg docker -c 'bash scripts/regtest.sh fork-now'
====================================================================
EOF
}

cmd_status() {
  local ch kh fork rdts invalid_at
  ch=$(C getblockcount); kh=$(K getblockcount)
  fork=$(param FORK_AT_HEIGHT)
  rdts=$(K getdeploymentinfo | python3 -c \
    "import sys,json;print(json.load(sys.stdin)['deployments']['reduced_data']['bip9']['status'])")
  # Height of the block Knots rejected, or empty. Deliberately NOT "is Core's *tip* invalid":
  # Knots never requests the descendants of a block it rejected, so once Core mines past the fork
  # its tip is simply absent from Knots' chaintips — the invalid entry stays pinned at the fork.
  invalid_at=$(K getchaintips | python3 -c \
    "import sys,json;t=[x['height'] for x in json.load(sys.stdin) if x['status']=='invalid'];print(min(t) if t else '')")

  echo "core height    $ch"
  echo "knots height   $kh"
  echo "rdts           $rdts"
  if [ -n "$invalid_at" ]; then
    echo "state          FORKED at $invalid_at (core is $((ch - kh)) ahead of knots)"
  else
    echo "state          agreed${fork:+, fork at $fork ($((fork - ch)) blocks to go)}"
  fi
  echo
  echo "params (compose/regtest.env + overrides):"
  for k in BLOCK_SPACING_SECS LEAD_BLOCKS VISIBLE_EPOCHS RETARGET_INTERVAL KNOTS_PER_100 \
           VIOLATION_BYTES FORK_AT_HEIGHT FLOOR_HEIGHT; do
    printf '  %-20s %s\n' "$k" "$(param "$k")"
  done
}

cmd_fork_now() {
  # Skip the countdown: point the miner's fork height at the current tip and restart it.
  local ch; ch=$(C getblockcount)
  put "FORK_AT_HEIGHT=$((ch + 1))"
  echo "[fork-now] tip $ch -> forking at $((ch + 1)); restarting miner + app"
  dc up -d app miner >/dev/null
  echo "[fork-now] done — the next Core block will be the violating one."
}

# Rebuild ONE service without disturbing the chain. `compose up --build app` is the trap this
# exists to avoid: it re-tags every image in the file, so the node images change too and compose
# recreates fw-core/fw-knots — restarting bitcoind mid-demo under the chain you are testing.
cmd_rebuild() {
  local svc="${1:-app}"
  echo "[rebuild] building $svc..."
  dc build "$svc" >/dev/null
  dc up -d --no-build --no-deps "$svc" >/dev/null
  echo "[rebuild] $svc restarted; nodes untouched."
}

case "${1:-help}" in
  reset)   shift; cmd_reset "$@";;
  rebuild) cmd_rebuild "${2:-app}";;
  status)  cmd_status;;
  fork-now) cmd_fork_now;;
  up)      shift; dc up -d --build "$@";;
  down)    dc down;;
  logs)    docker logs -f "${2:-fw-miner}";;
  params)  echo "# $PARAMS"; cat "$PARAMS"; echo; echo "# $RUNTIME (overrides)"; cat "$RUNTIME";;
  *) cat <<EOF
usage: bash scripts/regtest.sh <command>

  reset [KEY=VALUE ...]  wipe and rebuild the chain to compose/regtest.env (plus any overrides)
  rebuild [service]      rebuild one image (default app) and restart only it, leaving the chain up
  status                 heights, RDTS state, fork countdown, effective params
  fork-now               retarget the fork to the current tip and restart the miner
  up [service ...]       (re)start services with the current params
  down                   stop the stack (keeps the chain)
  logs [container]       follow a container's logs (default fw-miner)
  params                 print the parameter file and active overrides

examples:
  bash scripts/regtest.sh reset
  bash scripts/regtest.sh reset LEAD_BLOCKS=20 MINE_INTERVAL_SECS=3
  bash scripts/regtest.sh reset KNOTS_PER_100=10 PREFILL_BLOCKS=500
EOF
    exit 1;;
esac
