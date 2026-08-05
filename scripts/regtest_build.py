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

Set FORK_AT_HEIGHT to pin the fork to an exact height (mainnet's 961632) rather than letting it fall
out of wherever RDTS activation landed. The floor is then FORK_AT_HEIGHT - VISIBLE_EPOCHS*RETARGET,
and the bulk phase simply runs longer — at mainnet heights that is ~900k blocks, an hour or two, which
is why `scripts/regtest.sh snapshot` exists: you mine it once and restore from a tarball thereafter.

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
# Pin the fork to an exact height (mainnet's 961632) instead of deriving it from wherever RDTS
# activation happened to land. 0 keeps the old derive-from-activation behavior. Must be a multiple
# of RETARGET so the fork lands on the first block of an epoch, as it does on mainnet.
PIN_FORK = int(os.environ.get("FORK_AT_HEIGHT", "0"))

BULK_BATCH = 2500  # blocks per generatetoaddress call below the floor
BULK_SYNC_EVERY = 10  # let Knots catch up every N bulk batches (see bulk_mine)
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


def ensure_wallet(url, name="fw", on_startup=True):
    # load_on_startup=true (the trailing arg) is load-bearing: without it a wallet is loaded only
    # for the life of the bitcoind process, and any node restart — a `compose up --build`, a crash —
    # silently leaves the node with no wallet at all, which is how the fork's funding goes missing.
    args = [name, False, False, "", False, True, on_startup]
    try:
        rpc(url, "createwallet", args)
    except Exception:
        try:
            rpc(url, "loadwallet", [name, on_startup])
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


def wait_synced(timeout=300, progress=False):
    """Block until both nodes agree on the tip. Mining alternately on two peers without this races:
    Knots can extend a stale tip and split a chain that is supposed to be shared.

    `progress` is for the bulk phase, where Knots is not racing us but genuinely downloading tens of
    thousands of blocks behind a burst of `generatetoaddress`: poll lazily and report the gap, since
    a silent multi-minute stall there is indistinguishable from a hang."""
    deadline = time.time() + timeout
    last_log = 0.0
    while time.time() < deadline:
        if rpc(CORE, "getbestblockhash") == rpc(KNOTS, "getbestblockhash"):
            return True
        if progress and time.time() - last_log > 15:
            last_log = time.time()
            log(f"  knots catching up: {height(KNOTS)}/{height(CORE)}")
        time.sleep(1.0 if progress else 0.2)
    log(f"WARNING: nodes did not converge within {timeout}s "
        f"(core {height(CORE)}, knots {height(KNOTS)})")
    return False


def balance(url):
    try:
        return float(rpc(url, "getbalances")["mine"]["trusted"])
    except Exception:
        return 0.0


def burn_address():
    """An address in NO loaded wallet. Mining a bulk range to a wallet-owned address is ~8x
    slower — every coinbase becomes a wallet write — and the coins are never spent anyway.

    Both the create and the unload say load_on_startup=FALSE, and that is not a detail. bitcoind
    keeps the startup wallet list in settings.json; an `unloadwallet` that leaves the entry there
    means the next node start LOADS this wallet and rescans it — and by then it owns every coinbase
    in the bulk range. At the pinned mainnet fork height that is ~900k wallet transactions to
    reconstruct on a restart that should take seconds."""
    ensure_wallet(CORE, "burn", on_startup=False)
    addr = rpc(CORE + "/wallet/burn", "getnewaddress")
    rpc(CORE, "unloadwallet", ["burn", False])
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
    these blocks sit below the app's floor and are never ingested.

    `t` still advances a full SPACING per block even though the blocks inside one batch end up ~1s
    apart (they all see the same mocktime and are pushed past median-time-past one second at a
    time). That is deliberate: the ANCHOR is what matters — advancing t at the real block rate is
    what leaves the clock exactly where the visible window expects to start.

    At mainnet heights this phase is ~900k blocks, so it pauses every BULK_SYNC_EVERY batches to let
    Knots drain its download queue. Letting it trail unboundedly for an hour is how a converge-at-
    the-end wait turns into a 900k-block IBD with nothing reporting on it."""
    done = 0
    t = t_start
    batches = 0
    t0 = time.time()
    while done < n:
        batch = min(BULK_BATCH, n - done)
        mocktime(t)
        rpc(CORE, "generatetoaddress", [batch, addr])
        done += batch
        t += batch * SPACING
        batches += 1
        rate = done / max(0.001, time.time() - t0)
        log(f"  bulk {done}/{n} (height {height(CORE)}, {rate:.0f} blk/s, "
            f"~{int((n - done) / max(1.0, rate) / 60)}m left)")
        if batches % BULK_SYNC_EVERY == 0:
            wait_synced(timeout=3600, progress=True)
    return t


def visible_mine(n, caddr, kaddr, t_start):
    """Mine the app-visible window one block at a time, dated exactly SPACING apart and split at the
    Knots hashrate ratio. Per-block mocktime is the whole point: this range is what the UI measures
    spacing over, so its timestamps have to be real minutes apart, not the 1s/block the batch path
    produces."""
    t = t_start
    k_blocks = 0
    t0 = time.time()
    for i in range(1, n + 1):
        t += SPACING
        mocktime(t)
        if mines_knots(i):
            wait_synced()  # Knots must hold Core's tip before it extends it
            rpc(KNOTS, "generatetoaddress", [1, kaddr])
            # ...and Core must hold the result before it mines again, or it builds on the same
            # parent and the two blocks compete at one height. The loser is reorged out and the
            # run silently comes up short — a shared chain is supposed to have no orphans in it.
            wait_synced()
            k_blocks += 1
        else:
            rpc(CORE, "generatetoaddress", [1, caddr])
        if i % 500 == 0:
            rate = i / max(0.001, time.time() - t0)
            log(f"  visible {i}/{n} (height {height(CORE)}, {k_blocks} knots, "
                f"~{int((n - i) / max(0.001, rate) / 60)}m left)")
    wait_synced()
    log(f"  visible {n}/{n} done ({k_blocks} knots blocks, "
        f"{100.0 * k_blocks / max(1, n):.1f}%)")
    return t


def main():
    log(f"config: spacing={SPACING}s lead={LEAD} visible_epochs={VISIBLE_EPOCHS} "
        f"retarget={RETARGET} knots_per_100={KNOTS_PER_100} "
        f"fork_at={PIN_FORK or 'derived'}")
    # Fail on a bad pin BEFORE mining anything: the whole point of pinning is that the fork lands on
    # the first block of an epoch, and at mainnet heights the alternative is discovering the mistake
    # two hours into a build.
    if PIN_FORK and PIN_FORK % RETARGET != 0:
        sys.exit(f"[build] FORK_AT_HEIGHT={PIN_FORK} is not a multiple of RETARGET_INTERVAL="
                 f"{RETARGET}; it would not land on the first block of an epoch")
    wait_rpc()

    visible_total = VISIBLE_EPOCHS * RETARGET - LEAD  # blocks we mine inside the window
    if PIN_FORK:
        # Anchor the clock so the LAST block of the build (the parked tip, PIN_FORK - LEAD) is dated
        # NOW, with every block below it one SPACING earlier — i.e. the chain's whole timeline, not
        # just the visible window, is shaped as if it had been mined at the target rate. Both phases
        # advance `t` at exactly SPACING per block, so this single anchor carries all the way down.
        t = NOW - (PIN_FORK - LEAD) * SPACING
    else:
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
    if PIN_FORK:
        fork_h = PIN_FORK
        floor_h = fork_h - VISIBLE_EPOCHS * RETARGET
        if floor_h <= setup_h:
            sys.exit(f"[build] FORK_AT_HEIGHT={fork_h} leaves no room: the floor would be "
                     f"{floor_h}, at or below the setup tip {setup_h}. Raise FORK_AT_HEIGHT or "
                     f"lower VISIBLE_EPOCHS.")
    else:
        floor_h = ((setup_h // RETARGET) + 1) * RETARGET
        fork_h = floor_h + VISIBLE_EPOCHS * RETARGET
    target_h = fork_h - LEAD  # where the reset parks the tip; the live miner walks the rest
    log(f"plan: setup_tip={setup_h} floor={floor_h} fork={fork_h} park_at={target_h} "
        f"(visible window {fork_h - floor_h} blocks = {VISIBLE_EPOCHS} epochs)")

    # --- bulk: setup tip -> floor-1 (below the app's floor; speed over fidelity) ------------------
    # Stop ONE SHORT of the floor. The floor block is the oldest block the app ever displays, so if
    # bulk mines it it carries a batch-compressed timestamp and the very first interval on the rail
    # reads as hours instead of BLOCK_SPACING_SECS. Leaving it to the visible phase puts the seam
    # at floor-1 -> floor, entirely below what the app ingests.
    bulk_n = floor_h - 1 - setup_h
    if bulk_n > 0:
        log(f"bulk-mining {bulk_n} blocks to the floor...")
        t = bulk_mine(bulk_n, burn, t)
        wait_synced(timeout=3600, progress=True)
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
