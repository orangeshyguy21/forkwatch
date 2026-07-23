#!/usr/bin/env bash
# Forkwars e2e — Scenario A: fork on RDTS violation.
#
# Proves the dynamic the app visualizes: with RDTS active on Knots, Core accepts a block
# containing an RDTS-violating tx (>83-byte OP_RETURN) while Knots rejects it as invalid,
# producing a real chain-tip fork between the two nodes.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"

echo "== Scenario A: fork on RDTS violation =="
wait_rpc

echo "1) activate RDTS on Knots (mine bit-4 signaling blocks)"
activate_rdts

echo "2) fund Core (101 valid blocks to a Core address; both nodes accept)"
ensure_wallet C
CADDR=$(C getnewaddress)
C generatetoaddress 101 "$CADDR" >/dev/null
BASE=$(C getbestblockhash); BASEH=$(C getblockcount)
[ "$BASE" = "$(K getbestblockhash)" ] || { echo "FAIL: nodes not in sync before the fork"; exit 1; }
echo "   common tip: height=$BASEH hash=$BASE"

echo "3) Core mines an RDTS-violating block (200-byte OP_RETURN, rule 1)"
SIGNED=$(make_violating_tx 200)
TXID=$(C sendrawtransaction "$SIGNED")
VIOL=$(C generatetoaddress 1 "$CADDR" | j0)
echo "   violating txid=$TXID mined in block $VIOL (height $(C getblockcount))"
sleep 1   # let P2P relay the block to Knots so it forms its verdict

echo "4) assert the fork"
CT=$(C getbestblockhash); KT=$(K getbestblockhash); KV=$(knots_view_of "$VIOL")
echo "   Core  tip: $CT (h=$(C getblockcount))"
echo "   Knots tip: $KT (h=$(K getblockcount))  |  Knots view of Core's block: $KV"

fail=0
[ "$CT" = "$VIOL" ] || { echo "  ✗ Core did not adopt the violating block"; fail=1; }
[ "$KT" = "$BASE" ] || { echo "  ✗ Knots did not stay on the pre-fork tip"; fail=1; }
[ "$KV" = "invalid" ] || { echo "  ✗ Knots did not mark Core's block invalid (got: $KV)"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "PASS ✅  Core accepted the violation; Knots rejected it (status=invalid). Fork reproduced."
else
  echo "FAIL ❌"; exit 1
fi
