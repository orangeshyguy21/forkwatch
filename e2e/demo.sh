#!/usr/bin/env bash
# Bring up the full Forkwars regtest demo: two nodes + app + continuous miner.
# The miner activates RDTS, grows a shared chain (IN AGREEMENT), FORKS at the preprogrammed
# height, then keeps BOTH chains advancing. Just open http://localhost:8080 and watch.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="$HERE/../compose/docker-compose.regtest.yml"

echo "### resetting + building + starting full stack (nodes + app + miner) ###"
docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
docker compose -f "$COMPOSE" up -d --build

cat <<'EOF'

====================================================================
 Forkwars demo is starting.   Open:  http://localhost:8080

 The miner will (watch it live):
   1. activate RDTS on Knots,
   2. grow a shared chain  -> banner shows "IN AGREEMENT" + a
      "FORK SCHEDULED AT #560 — N blocks to go" countdown,
   3. at height 560 mine an RDTS-violating block on Core  -> FORK,
   4. keep BOTH chains advancing (Core ahead on its invalid branch,
      Knots on its valid minority chain).

 Miner log:   sg docker -c 'docker logs -f fw-miner'
 Stop:        sg docker -c 'docker compose -f compose/docker-compose.regtest.yml down'
====================================================================
EOF
