#!/usr/bin/env bash
# Reset the Forkwars regtest stack to a clean state and run the e2e scenarios.
# Usage: bash e2e/run.sh   (from the repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="$HERE/../compose/docker-compose.regtest.yml"

echo "### resetting regtest nodes (down -v + up core/knots) ###"
docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
docker compose -f "$COMPOSE" up -d core knots >/dev/null   # nodes only; the app is a separate service

echo "### waiting for nodes to report healthy ###"
for n in fw-core fw-knots; do
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$n" 2>/dev/null)" = "healthy" ]; do sleep 1; done
  echo "  $n healthy"
done

echo "### running scenarios ###"
bash "$HERE/scenarios/fork_on_violation.sh"
