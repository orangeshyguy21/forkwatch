#!/usr/bin/env bash
# Clear the Forkwars app SQLite DB for an environment, then restart the app so it re-backfills
# from the node tips. Usage:  sg docker -c 'bash scripts/clear-db.sh [regtest|mainnet]'
set -euo pipefail
ENVN="${1:-regtest}"
HERE=$(cd "$(dirname "$0")/.." && pwd)

case "$ENVN" in
  regtest) COMPOSE="$HERE/compose/docker-compose.regtest.yml"; VOL=forkwars-regtest_app-db;;
  mainnet) COMPOSE="$HERE/compose/docker-compose.mainnet.yml"; VOL=forkwars-mainnet_app-db;;
  *) echo "usage: clear-db.sh [regtest|mainnet]"; exit 1;;
esac

echo "[clear-db] stopping $ENVN app..."
docker compose -f "$COMPOSE" stop app >/dev/null 2>&1 || true

echo "[clear-db] wiping SQLite in volume $VOL ..."
docker run --rm -v "${VOL}:/data" debian:bookworm-slim \
  sh -c 'rm -f /data/forkwars.db /data/forkwars.db-wal /data/forkwars.db-shm' || true

echo "[clear-db] restarting $ENVN app (it will re-backfill from the node tips)..."
docker compose -f "$COMPOSE" up -d app >/dev/null
echo "[clear-db] done."
