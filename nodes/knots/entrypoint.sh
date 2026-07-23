#!/bin/sh
# Node entrypoint: run bitcoind, and (mainnet) load an assumeutxo snapshot once, one time.
# Backward compatible with regtest (no LOAD_SNAPSHOT env -> just runs bitcoind).
set -eu
DATADIR=/data
RPC_CONF="$DATADIR/rpc.conf"

# --- RPC auth ------------------------------------------------------------------------------------
# The RPC password must never appear on a command line: /proc is world-readable, so `ps aux` on the
# HOST shows every argument of every container process to any unprivileged local account (no docker
# group required). So instead of -rpcpassword=..., derive the rpcauth SALTED HASH and write it to a
# 0600 file that bitcoin.conf pulls in via `includeconf=rpc.conf`.
#
# Two consequences, which are the point of the exercise:
#   - bitcoind holds only the hash; the plaintext password is nowhere on disk in this container.
#   - with no -rpcpassword set, bitcoind writes its usual .cookie, so every local bitcoin-cli call
#     (below, and in the compose healthchecks) authenticates with NO credentials on its command line
#     at all. The app still authenticates over the network as RPC_USER/RPC_PASS against the hash.
umask 077
if [ -n "${RPC_USER:-}" ] && [ -n "${RPC_PASS:-}" ]; then
  SALT=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  HMAC=$(printf '%s' "$RPC_PASS" | openssl dgst -sha256 -hmac "$SALT" | sed 's/^.*= *//')
  printf 'rpcauth=%s:%s$%s\n' "$RPC_USER" "$SALT" "$HMAC" > "$RPC_CONF"
  echo "[entrypoint] rpcauth configured for user '$RPC_USER' (hash only; local cli uses cookie)"
else
  # No credentials supplied (e.g. a bare `docker run`): leave the include present but empty so
  # bitcoind still starts, and let it fall back to pure cookie auth as before.
  : > "$RPC_CONF"
  echo "[entrypoint] no RPC_USER/RPC_PASS supplied; cookie auth only"
fi
chmod 600 "$RPC_CONF"

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
