#!/usr/bin/env bash
# Trigger a live fork: mine an RDTS-violating block (200-byte OP_RETURN) on Core.
# Core accepts it; Knots rejects it. Watch http://localhost:8080 split into two lanes.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

ensure_wallet C
CADDR=$(C getnewaddress)
echo "Mining an RDTS-violating block (200-byte OP_RETURN, rule 1) on Core..."
SIGNED=$(make_violating_tx 200)
TXID=$(C sendrawtransaction "$SIGNED")
VIOL=$(C generatetoaddress 1 "$CADDR" | j0)
sleep 2

echo "  Core mined $VIOL  (Core h=$(C getblockcount), Knots h=$(K getblockcount))"
echo "  Knots view of Core's tip: $(knots_view_of "$VIOL")"
echo "→ http://localhost:8080 should now show FORKED — 1 BLOCK."
