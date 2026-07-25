#!/usr/bin/env bash
# Forkwatch client-resource benchmark.
#
# Wraps profile.mjs in the puppeteer image (there is no node on the host) and points it at a running
# app. Everything after the scenario is passed straight through to profile.mjs.
#
#   ./bench.sh                                  # idle, default variants, regtest :8080
#   ./bench.sh scroll                           # same variants, flying the chain
#   ./bench.sh idle --base http://127.0.0.1:8081   # mainnet (agreement + countdown)
#   ./bench.sh idle --variant 'a:' --variant 'b:?bg=off' --repeat 5
#
# Results land in scripts/perf/out/<scenario>-<stamp>.json. Compare two runs with compare.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PERF="$ROOT/scripts/perf"
OUT="$PERF/out"
mkdir -p "$OUT"

SCENARIO="${1:-idle}"
[ $# -gt 0 ] && shift

# --out-name gives the result file a stable name instead of a timestamp, so a before/after pair is
# easy to refer to later. Stripped here; profile.mjs never sees it.
OUT_NAME=""
REST=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out-name) OUT_NAME="$2"; shift 2 ;;
    *) REST+=("$1"); shift ;;
  esac
done
set -- ${REST[@]+"${REST[@]}"}

# Default axis: the backdrop, isolated by its own ?bg= debug param. Override with your own --variant
# list to benchmark anything else (?zoom=, ?focus=, or two builds on different ports).
DEFAULTS=(--variant 'full:' --variant 'bg-off:?bg=off' --variant 'lattice:?bg=lattice' --variant 'field:?bg=field')
ARGS=("$@")
if ! printf '%s\n' "${ARGS[@]:-}" | grep -q -- '--variant'; then
  ARGS=("${DEFAULTS[@]}" "${ARGS[@]:-}")
fi

NAME="${OUT_NAME:-$SCENARIO-$(date +%Y%m%d-%H%M%S)}"

# --network host so the container reaches the app on 127.0.0.1, and so the /proc CPU sampling in
# profile.mjs sees only this container's chromium processes.
# --init reaps the zombie chromium helpers a long multi-variant run leaves behind.
docker run --rm --init --network host \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
  -v "$PERF":/usr/src/app/perf:ro \
  -v "$OUT":/out \
  --entrypoint node \
  zenika/alpine-chrome:with-puppeteer \
  /usr/src/app/perf/profile.mjs \
  --scenario "$SCENARIO" \
  --out "/out/$NAME.json" \
  "${ARGS[@]}"

echo "→ $OUT/$NAME.json"
