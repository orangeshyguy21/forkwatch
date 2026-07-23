#!/bin/sh
# Node entrypoint: run bitcoind, and (mainnet) load an assumeutxo snapshot once, one time.
# Backward compatible with regtest (no LOAD_SNAPSHOT env -> just runs bitcoind).
set -eu
DATADIR=/data

bitcoind -datadir="$DATADIR" &
BPID=$!

stop_node() {
  bitcoin-cli -datadir="$DATADIR" stop >/dev/null 2>&1 || kill "$BPID" 2>/dev/null || true
  wait "$BPID" 2>/dev/null || true
  exit 0
}
trap stop_node TERM INT

# Wait for RPC.
until bitcoin-cli -datadir="$DATADIR" getblockchaininfo >/dev/null 2>&1; do sleep 2; done
echo "[entrypoint] RPC up"

# One-time assumeutxo load (only if LOAD_SNAPSHOT is set and not already loaded).
if [ "${LOAD_SNAPSHOT:-}" != "" ] && [ -f "${LOAD_SNAPSHOT}" ] && [ ! -f "$DATADIR/.snapshot_loaded" ]; then
  SNAP_H="${SNAPSHOT_HEIGHT:-840000}"
  echo "[entrypoint] snapshot ${LOAD_SNAPSHOT} pending; waiting for headers >= ${SNAP_H} (over Tor)"
  while : ; do
    H=$(bitcoin-cli -datadir="$DATADIR" getblockchaininfo 2>/dev/null | grep -o '"headers":[ ]*[0-9]*' | grep -o '[0-9]*$' || true)
    if [ -n "${H:-}" ] && [ "$H" -ge "$SNAP_H" ]; then break; fi
    echo "[entrypoint] headers ${H:-0}/${SNAP_H} ..."
    sleep 20
  done
  echo "[entrypoint] loading UTXO snapshot (a few minutes)..."
  if bitcoin-cli -datadir="$DATADIR" loadtxoutset "$LOAD_SNAPSHOT"; then
    touch "$DATADIR/.snapshot_loaded"
    echo "[entrypoint] snapshot loaded OK"
  else
    echo "[entrypoint] loadtxoutset failed; will retry on next start"
  fi
fi

wait "$BPID"
