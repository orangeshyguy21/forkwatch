#!/usr/bin/env python3
"""Walk a just-restored regtest chain up to exactly LEAD_BLOCKS below the fork.

The 'prefork' snapshot is parked wherever the reset that built it left the tip (a lead of 100), so
`restore` alone always gives you that same countdown. This closes the gap to whatever lead you
actually want to watch, using the SAME mining path the reset uses (regtest_build.visible_mine):
one block at a time, per-block mocktime exactly BLOCK_SPACING_SECS apart, split at the Knots
hashrate ratio — so the catch-up blocks are indistinguishable from the history below them and the
UI's measured spacing stays honest. The last block is dated NOW and mocktime is cleared, so the
live miner picks up on the real clock with no seam.

Driven by `regtest.sh arm`; it must run with the nodes up and the MINER STOPPED, or the tip moves
under it. Reads compose/regtest.env (+ .regtest.runtime.env overrides) the same way regtest.sh does.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env_from(path, keys):
    """Parse KEY=VALUE lines out of an env file, keeping only `keys`."""
    out = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k in keys:
                    out[k] = v
    except FileNotFoundError:
        pass
    return out


KEYS = {"BLOCK_SPACING_SECS", "LEAD_BLOCKS", "KNOTS_PER_100", "FORK_AT_HEIGHT"}
params = env_from(f"{HERE}/compose/regtest.env", KEYS)
params.update(env_from(f"{HERE}/compose/.regtest.runtime.env", KEYS))  # runtime wins, as in regtest.sh
creds = env_from(f"{HERE}/compose/.env", {"FW_RPC_USER", "FW_RPC_PASS"})

# regtest_build reads all of its configuration at import time, so this has to come first.
os.environ["BLOCK_SPACING_SECS"] = params["BLOCK_SPACING_SECS"]
os.environ["KNOTS_PER_100"] = params.get("KNOTS_PER_100", "1")
os.environ["RPC_USER"] = creds.get("FW_RPC_USER", "forkwars")
os.environ["RPC_PASS"] = creds.get("FW_RPC_PASS", "forkwars_regtest")

sys.path.insert(0, f"{HERE}/scripts")
import regtest_build as B  # noqa: E402

FORK = int(params["FORK_AT_HEIGHT"])
# Lead: argv[1] beats the params file, so `arm 12` is a one-off without editing anything.
LEAD = int(sys.argv[1]) if len(sys.argv) > 1 else int(params["LEAD_BLOCKS"])
TARGET = FORK - LEAD


def main():
    B.wait_rpc()
    ch, kh = B.height(B.CORE), B.height(B.KNOTS)
    B.log(f"core={ch} knots={kh} fork={FORK} lead={LEAD} -> park at {TARGET} "
          f"(spacing {B.SPACING}s, knots {B.KNOTS_PER_100}/100)")
    if ch != kh:
        B.log("nodes disagree on height; waiting for sync")
        B.wait_synced()
        ch = B.height(B.CORE)

    n = TARGET - ch
    if n < 0:
        sys.exit(f"[arm] tip {ch} is already past the park height {TARGET} — restore first "
                 f"(a lead of {FORK - ch} or less is all this snapshot can give you)")
    if n == 0:
        B.log("already parked; nothing to mine")
        return

    B.ensure_wallet(B.CORE)
    B.ensure_wallet(B.KNOTS)
    caddr = B.rpc(B.CORE, "getnewaddress")
    kaddr = B.rpc(B.KNOTS, "getnewaddress")

    # Date the run so the LAST block lands at now. The live miner takes over on the real clock, so
    # any other anchor leaves a seam between the parked tip and the first live block — and with the
    # ETA recency-weighted over ~35 blocks, a seam inside a short lead is most of the countdown.
    now = int(time.time())
    t_start = now - n * B.SPACING
    last = B.tip_time(B.CORE)
    if t_start <= last:
        B.log(f"WARNING: run would start at/behind the tip time ({last}); shifting forward")
        t_start = last + B.SPACING

    B.log(f"mining {n} blocks {ch} -> {TARGET}, dated {B.SPACING}s apart, ending now...")
    B.visible_mine(n, caddr, kaddr, t_start)

    # Hand the clock back before the miner starts.
    B.rpc(B.CORE, "setmocktime", [0])
    B.rpc(B.KNOTS, "setmocktime", [0])

    ch, kh = B.height(B.CORE), B.height(B.KNOTS)
    bal = B.balance(B.CORE)
    B.log(f"parked: core={ch} knots={kh} ({FORK - ch} blocks to the fork), core balance {bal}")
    # Same check the reset makes, for the same reason: without spendable coins the miner cannot
    # build the violating tx, and you find out when the countdown reaches zero.
    if bal < 1.0:
        sys.exit(f"[arm] FAILED: Core has {bal} spendable BTC — cannot fund the violating tx")


if __name__ == "__main__":
    main()
