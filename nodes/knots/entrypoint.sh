#!/bin/sh
# Node entrypoint: run bitcoind, and (mainnet) load an assumeutxo snapshot once, one time.
# Backward compatible with regtest (no LOAD_SNAPSHOT env -> just runs bitcoind).
set -eu
DATADIR=/data

# RPC auth comes from the environment (single source of truth: compose/.env for mainnet, the
# compose defaults for regtest) rather than being baked into the tracked bitcoin.conf, so no secret
# lives in git. These flags are handed to bitcoind AND to every bitcoin-cli call below; when unset
# (e.g. a bare `docker run`) bitcoind falls back to cookie auth as before.
RPC_ARGS=""
[ -n "${RPC_USER:-}" ] && RPC_ARGS="$RPC_ARGS -rpcuser=$RPC_USER"
[ -n "${RPC_PASS:-}" ] && RPC_ARGS="$RPC_ARGS -rpcpassword=$RPC_PASS"

# shellcheck disable=SC2086  # RPC_ARGS is intentionally word-split into separate flags.
bitcoind -datadir="$DATADIR" $RPC_ARGS &
BPID=$!

stop_node() {
  # shellcheck disable=SC2086
  bitcoin-cli -datadir="$DATADIR" $RPC_ARGS stop >/dev/null 2>&1 || kill "$BPID" 2>/dev/null || true
  wait "$BPID" 2>/dev/null || true
  exit 0
}
trap stop_node TERM INT

# Wait for RPC.
# shellcheck disable=SC2086
until bitcoin-cli -datadir="$DATADIR" $RPC_ARGS getblockchaininfo >/dev/null 2>&1; do sleep 2; done
echo "[entrypoint] RPC up"

# One-time assumeutxo load (only if LOAD_SNAPSHOT is set and not already loaded).
if [ "${LOAD_SNAPSHOT:-}" != "" ] && [ -f "${LOAD_SNAPSHOT}" ] && [ ! -f "$DATADIR/.snapshot_loaded" ]; then
  SNAP_H="${SNAPSHOT_HEIGHT:-840000}"
  echo "[entrypoint] snapshot ${LOAD_SNAPSHOT} pending; waiting for headers >= ${SNAP_H} (over Tor)"
  while : ; do
    # shellcheck disable=SC2086
    H=$(bitcoin-cli -datadir="$DATADIR" $RPC_ARGS getblockchaininfo 2>/dev/null | grep -o '"headers":[ ]*[0-9]*' | grep -o '[0-9]*$' || true)
    if [ -n "${H:-}" ] && [ "$H" -ge "$SNAP_H" ]; then break; fi
    echo "[entrypoint] headers ${H:-0}/${SNAP_H} ..."
    sleep 20
  done
  echo "[entrypoint] loading UTXO snapshot (a few minutes)..."
  # shellcheck disable=SC2086
  if bitcoin-cli -datadir="$DATADIR" $RPC_ARGS loadtxoutset "$LOAD_SNAPSHOT"; then
    touch "$DATADIR/.snapshot_loaded"
    echo "[entrypoint] snapshot loaded OK"
  else
    echo "[entrypoint] loadtxoutset failed; will retry on next start"
  fi
fi

wait "$BPID"
