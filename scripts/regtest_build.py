#!/usr/bin/env python3
"""
Build the Forkwatch regtest chain into a scaled mirror of the mainnet BIP-110 deployment.

Run against an already-up, freshly wiped pair of nodes. Produces, in order:

  1. RDTS activation on Knots (burst-mined bit-4 signaling blocks) + a funded Core wallet,
  2. bulk history up to FLOOR_HEIGHT — the first retarget boundary above the activation burst.
     The app never ingests below its floor, so this is mined on Core alone, in big batches,
     purely to get the chain to a mainnet-shaped starting height,
  3. the visible window, FLOOR_HEIGHT -> FORK_AT_HEIGHT - LEAD_BLOCKS, mined one block at a time
     at the KNOTS_PER_100 ratio with timestamps exactly BLOCK_SPACING_SECS apart, ending at ~now.

Blocks are dated with `setmocktime`: regtest rejects timestamps more than 2h ahead of the node's
clock, so mining thousands of blocks at real time is impossible — and dating them deliberately is
what makes the app's spacing measurement, ETA and retarget arithmetic behave as they will on
mainnet. Mocktime is cleared at the end so the live miner runs on the real clock.

Prints the plan as `FORK_AT_HEIGHT=<n>` / `FLOOR_HEIGHT=<n>` / `HEIGHT=<n>` on the last lines;
scripts/regtest.sh reads those into the app + miner environment.

Talks to the host-exposed RPC ports (Core 18443, Knots 18453). Pure stdlib.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

CORE = os.environ.get("CORE_RPC_URL", "http://localhost:18443")
KNOTS = os.environ.get("KNOTS_RPC_URL", "http://localhost:18453")
USER = os.environ.get("RPC_USER", "forkwars")
PASS = os.environ.get("RPC_PASS", "forkwars_regtest")

SPACING = int(os.environ.get("BLOCK_SPACING_SECS", "20"))
LEAD = int(os.environ.get("LEAD_BLOCKS", "100"))
VISIBLE_EPOCHS = int(os.environ.get("VISIBLE_EPOCHS", "2"))
RETARGET = int(os.environ.get("RETARGET_INTERVAL", "2016"))
KNOTS_PER_100 = max(0, min(100, int(os.environ.get("KNOTS_PER_100", "1"))))
NOW = int(os.environ.get("BUILD_NOW", str(int(time.time()))))

BULK_BATCH = 2500  # blocks per generatetoaddress call below the floor
FUND_BLOCKS = 101  # coinbases mined to Core's wallet right after activation (see main())

_AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()


def log(*a):
    print("[build]", *a, flush=True)


def rpc(url, method, params=None):
    body = json.dumps({"jsonrpc": "1.0", "id": "build", "method": method,
                       "params": params or []}).encode()
    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", _AUTH)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        d = json.load(e)
    if d.get("error"):
        raise RuntimeError(f"{method}: {d['error']}")
    return d["result"]


def wait_rpc():
    for _ in range(180):
        try:
            rpc(CORE, "getblockchaininfo")
            rpc(KNOTS, "getblockchaininfo")
            return
        except Exception:
            time.sleep(1)
    sys.exit("[build] nodes never became reachable")


def ensure_wallet(url, name="fw"):
    # load_on_startup=true (the trailing arg) is load-bearing: without it a wallet is loaded only
    # for the life of the bitcoind process, and any node restart — a `compose up --build`, a crash —
    # silently leaves the node with no wallet at all, which is how the fork's funding goes missing.
    args = [name, False, False, "", False, True, True]
    try:
        rpc(url, "createwallet", args)
    except Exception:
        try:
            rpc(url, "loadwallet", [name, True])
        except Exception:
            pass


def height(url):
    return rpc(url, "getblockcount")


def tip_time(url):
    return rpc(url, "getblockheader", [rpc(url, "getbestblockhash")])["time"]


def rdts_active():
    rd = rpc(KNOTS, "getdeploymentinfo").get("deployments", {}).get("reduced_data")
    return bool(rd and rd.get("active"))


def mocktime(t):
    """Both nodes must share the clock: Core's blocks are dated by Core, Knots' by Knots, and a
    node judges 'too far in the future' against its own."""
    rpc(CORE, "setmocktime", [t])
    rpc(KNOTS, "setmocktime", [t])


def wait_synced(timeout=300):
    """Block until both nodes agree on the tip. Mining alternately on two peers without this races:
    Knots can extend a stale tip and split a chain that is supposed to be shared."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if rpc(CORE, "getbestblockhash") == rpc(KNOTS, "getbestblockhash"):
            return True
        time.sleep(0.2)
    log(f"WARNING: nodes did not converge within {timeout}s "
        f"(core {height(CORE)}, knots {height(KNOTS)})")
    return False


def balance(url):
    try:
        return float(rpc(url, "getbalances")["mine"]["trusted"])
    except Exception:
        return 0.0


def burn_address():
    """An address in NO loaded wallet. Mining a bulk range to a wallet-owned address is ~20x
    slower — every coinbase becomes a wallet write — and the coins are never spent anyway."""
    ensure_wallet(CORE, "burn")
    addr = rpc(CORE + "/wallet/burn", "getnewaddress")
    rpc(CORE, "unloadwallet", ["burn"])
    return addr


def mines_knots(i):
    """True if block i of a run should come from Knots, spreading KNOTS_PER_100 evenly per 100.
    Same rule the live miner uses, so history and live blocks share one hashrate model."""
    if KNOTS_PER_100 <= 0:
        return False
    slot = i % 100
    return (slot * KNOTS_PER_100) // 100 != ((slot - 1) * KNOTS_PER_100) // 100


def bulk_mine(n, addr, t_start):
    """Mine n blocks on Core in batches. Timestamps only have to be monotonic and non-future here:
    these blocks sit below the app's floor and are never ingested."""
    done = 0
    t = t_start
    while done < n:
        batch = min(BULK_BATCH, n - done)
        mocktime(t)
        rpc(CORE, "generatetoaddress", [batch, addr])
        done += batch
        t += batch * SPACING
        log(f"  bulk {done}/{n} (height {height(CORE)})")
    return t


def visible_mine(n, caddr, kaddr, t_start):
    """Mine the app-visible window one block at a time, dated exactly SPACING apart and split at the
    Knots hashrate ratio. Per-block mocktime is the whole point: this range is what the UI measures
    spacing over, so its timestamps have to be real minutes apart, not the 1s/block the batch path
    produces."""
    t = t_start
    k_blocks = 0
    for i in range(1, n + 1):
        t += SPACING
        mocktime(t)
        if mines_knots(i):
            wait_synced()  # Knots must hold Core's tip before it extends it
            rpc(KNOTS, "generatetoaddress", [1, kaddr])
            k_blocks += 1
        else:
            rpc(CORE, "generatetoaddress", [1, caddr])
        if i % 500 == 0:
            log(f"  visible {i}/{n} (height {height(CORE)}, {k_blocks} knots)")
    wait_synced()
    log(f"  visible {n}/{n} done ({k_blocks} knots blocks, "
        f"{100.0 * k_blocks / max(1, n):.1f}%)")
    return t


def main():
    log(f"config: spacing={SPACING}s lead={LEAD} visible_epochs={VISIBLE_EPOCHS} "
        f"retarget={RETARGET} knots_per_100={KNOTS_PER_100}")
    wait_rpc()

    visible_total = VISIBLE_EPOCHS * RETARGET - LEAD  # blocks we mine inside the window
    # Start far enough back that the whole build is in the past; the visible phase is re-anchored
    # to end at NOW once its exact length is known.
    t = NOW - (visible_total + 20000) * SPACING
    # Set the clock BEFORE creating any wallet. A wallet records a birth time and ignores blocks
    # dated before it — create it at real "now" and every back-dated block we then mine is invisible
    # to it, leaving the fork's funding coins unspendable even though the keys are in the wallet.
    mocktime(t)

    ensure_wallet(CORE)
    ensure_wallet(KNOTS)
    caddr = rpc(CORE, "getnewaddress")
    kaddr = rpc(KNOTS, "getnewaddress")
    burn = burn_address()

    # --- setup: RDTS activation + a funded Core wallet -------------------------------------------
    if not rdts_active():
        log("activating RDTS on Knots (burst-mining bit-4 signaling blocks)...")
        guard = 0
        while not rdts_active():
            rpc(KNOTS, "generatetoaddress", [50, kaddr])
            t += 50 * SPACING
            mocktime(t)
            guard += 1
            if guard > 60:
                sys.exit("[build] RDTS never activated")
    wait_synced()
    log(f"RDTS active at height {height(KNOTS)}")

    # Fund Core HERE and only here. The regtest block subsidy halves every 150 blocks, so it is
    # already 0 by height ~4950 — a coinbase mined anywhere near the fork is literally worthless and
    # cannot pay for the violating transaction. These blocks, at height ~450, are the last cheap
    # source of spendable value in the whole chain; everything after them is mined for shape alone.
    log(f"funding Core ({FUND_BLOCKS} blocks at height {height(CORE)})...")
    rpc(CORE, "generatetoaddress", [FUND_BLOCKS, caddr])
    t += FUND_BLOCKS * SPACING
    wait_synced()

    # --- plan: mirror mainnet's shape (floor and fork on retarget boundaries) ---------------------
    setup_h = height(CORE)
    floor_h = ((setup_h // RETARGET) + 1) * RETARGET
    fork_h = floor_h + VISIBLE_EPOCHS * RETARGET
    target_h = fork_h - LEAD  # where the reset parks the tip; the live miner walks the rest
    log(f"plan: setup_tip={setup_h} floor={floor_h} fork={fork_h} park_at={target_h} "
        f"(visible window {fork_h - floor_h} blocks = {VISIBLE_EPOCHS} epochs)")

    # --- bulk: setup tip -> floor (below the app's floor; speed over fidelity) --------------------
    bulk_n = floor_h - setup_h
    if bulk_n > 0:
        log(f"bulk-mining {bulk_n} blocks to the floor...")
        t = bulk_mine(bulk_n, burn, t)
        wait_synced()
    log(f"core spendable balance after maturity: {balance(CORE)}")

    # --- visible: floor -> park height, dated to end at NOW ---------------------------------------
    vis_n = target_h - height(CORE)
    if vis_n > 0:
        t_start = NOW - vis_n * SPACING
        last = tip_time(CORE)
        if t_start <= last:  # setup ran long; keep timestamps monotonic rather than exact
            log(f"WARNING: visible window would start at/behind the tip time; shifting forward")
            t_start = last + SPACING
        log(f"mining {vis_n} visible blocks at {SPACING}s spacing "
            f"(history spans {vis_n * SPACING // 3600}h, ending now)...")
        visible_mine(vis_n, caddr, kaddr, t_start)

    # Hand the clock back: the live miner mines in real time from here.
    rpc(CORE, "setmocktime", [0])
    rpc(KNOTS, "setmocktime", [0])

    # The fork is a *funded* transaction: without spendable coins the miner cannot build the
    # violating tx and the whole point of the reset is lost. Fail here, loudly, not 33 minutes
    # from now when the countdown reaches zero.
    bal = balance(CORE)
    if bal < 1.0:
        sys.exit(f"[build] FAILED: Core has {bal} spendable BTC — cannot fund the violating tx. "
                 f"The funding blocks at height ~{setup_h - FUND_BLOCKS} did not survive.")
    log(f"core spendable balance: {bal}")

    ch, kh = height(CORE), height(KNOTS)
    if ch != kh:
        log(f"WARNING: nodes disagree after build (core {ch}, knots {kh})")
    log(f"built: core={ch} knots={kh} rdts_active={rdts_active()}")
    print(f"FORK_AT_HEIGHT={fork_h}")
    print(f"FLOOR_HEIGHT={floor_h}")
    print(f"HEIGHT={min(ch, kh)}")


if __name__ == "__main__":
    main()
