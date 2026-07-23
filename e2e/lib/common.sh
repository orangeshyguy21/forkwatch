#!/usr/bin/env bash
# Shared helpers for Forkwars regtest e2e scenarios.
# Assumes the docker-compose.regtest.yml stack is up (containers fw-core, fw-knots).
set -euo pipefail

C() { docker exec fw-core  bitcoin-cli -datadir=/data "$@"; }   # Core  (no RDTS)
K() { docker exec fw-knots bitcoin-cli -datadir=/data "$@"; }   # Knots (enforces RDTS)

# --- tiny JSON helpers (avoid depending on jq inside containers) ---
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)[sys.argv[1]])" "$1"; }  # top-level field
j0()   { python3 -c "import sys,json;print(json.load(sys.stdin)[0])"; }                 # first array elem

rdts_status() {
  K getdeploymentinfo | python3 -c \
    "import sys,json;print(json.load(sys.stdin)['deployments']['reduced_data']['bip9']['status'])"
}

# Status Knots assigns to a given block hash in getchaintips (or 'absent').
knots_view_of() {
  K getchaintips | python3 -c \
    "import sys,json;h=sys.argv[1];t=json.load(sys.stdin);print(next((x['status'] for x in t if x['hash']==h),'absent'))" "$1"
}

wait_rpc() { C -rpcwait getblockchaininfo >/dev/null; K -rpcwait getblockchaininfo >/dev/null; }

ensure_wallet() { $1 createwallet fw >/dev/null 2>&1 || $1 loadwallet fw >/dev/null 2>&1 || true; }

# Drive RDTS from the regtest NEVER_ACTIVE override (set via vbparams=reduced_data:0:...) to ACTIVE
# by mining bit-4-signaling blocks on Knots (the internal miner signals started deployments).
activate_rdts() {
  ensure_wallet K
  local kaddr st guard=0
  kaddr=$(K getnewaddress)
  st=$(rdts_status)
  while [ "$st" != "active" ] && [ "$guard" -lt 20 ]; do
    K generatetoaddress 100 "$kaddr" >/dev/null
    st=$(rdts_status); guard=$((guard+1))
    echo "   [activate] height $(K getblockcount): reduced_data=$st"
  done
  [ "$st" = "active" ] || { echo "ERROR: RDTS failed to activate"; return 1; }
}

# Build a raw tx with one RDTS-rule-1-violating output (OP_RETURN payload > 83 bytes),
# fund+sign it from Core's wallet, and return the signed hex.
make_violating_tx() {  # make_violating_tx <bytes>   (default 200)
  local n=${1:-200} payload raw funded
  payload=$(printf 'ab%.0s' $(seq 1 "$n"))            # n bytes -> scriptPubKey >> 83
  raw=$(C createrawtransaction '[]' "[{\"data\":\"$payload\"}]")
  funded=$(C fundrawtransaction "$raw" | jget hex)
  C signrawtransactionwithwallet "$funded" | jget hex
}
