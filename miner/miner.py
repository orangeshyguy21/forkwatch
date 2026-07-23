#!/usr/bin/env python3
"""
Forkwars regtest miner/driver — simulates block production with realistic BIP-110 hashrate.

Hashrate model: out of every 100 blocks, Core (Bitcoin, no RDTS) mines KNOTS_PER_100-complement and
Knots (RDTS) mines KNOTS_PER_100 (default 1 -> ~1% BIP-110 hashrate, matching reality). This makes:
  - pre-fork: the shared chain's bit-4 signaling ~= 1% (Knots blocks signal, Core blocks don't),
  - post-fork: Core races ahead ~99x while the Knots minority chain crawls.

Timeline:
  A. Activate RDTS on Knots (burst-mine bit-4 signaling blocks) + fund Core.
  B. Steady state at the hashrate ratio until FORK_AT_HEIGHT.
  C. FORK: Core mines an RDTS-violating block (Knots rejects it).
  D. Keep mining at the ratio forever — Core extends its (Knots-invalid) chain, Knots its own valid one.

Pure stdlib. JSON-RPC over HTTP to both nodes.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.request

CORE = os.environ.get("CORE_RPC_URL", "http://core:18443")
KNOTS = os.environ.get("KNOTS_RPC_URL", "http://knots:18443")
USER = os.environ.get("RPC_USER", "forkwars")
PASS = os.environ.get("RPC_PASS", "forkwars_regtest")
INTERVAL = float(os.environ.get("MINE_INTERVAL_SECS", "3"))
FORK_AT = int(os.environ.get("FORK_AT_HEIGHT", "560"))
PRE_FORK_BLOCKS = int(os.environ.get("PRE_FORK_BLOCKS", "18"))
KNOTS_PER_100 = max(0, min(100, int(os.environ.get("KNOTS_PER_100", "1"))))  # Knots blocks per 100

_AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()


def log(*a):
    print("[miner]", *a, flush=True)


def rpc(url, method, params=None):
    body = json.dumps({"jsonrpc": "1.0", "id": "miner", "method": method,
                       "params": params or []}).encode()
    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", _AUTH)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
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
    raise SystemExit("[miner] nodes never became reachable")


def ensure_wallet(url):
    try:
        rpc(url, "createwallet", ["fw"])
    except Exception:
        try:
            rpc(url, "loadwallet", ["fw"])
        except Exception:
            pass


def h(url):
    return rpc(url, "getblockcount")


def best(url):
    return rpc(url, "getbestblockhash")


def mine(url, n, addr):
    return rpc(url, "generatetoaddress", [n, addr])


def rdts_active():
    rd = rpc(KNOTS, "getdeploymentinfo").get("deployments", {}).get("reduced_data")
    return bool(rd and rd.get("active"))


def is_forked():
    """A REAL fork = Knots marks Core's tip invalid (not a transient sync lag)."""
    try:
        cbest = best(CORE)
        for t in rpc(KNOTS, "getchaintips"):
            if t.get("hash") == cbest and t.get("status") == "invalid":
                return True
    except Exception:
        pass
    return False


def core_mature_balance():
    try:
        return float(rpc(CORE, "getbalances")["mine"]["trusted"])
    except Exception:
        return 0.0


def mine_violating_block(caddr):
    payload = "ab" * 200  # 200-byte OP_RETURN -> ~203-byte scriptPubKey (RDTS rule 1)
    raw = rpc(CORE, "createrawtransaction", [[], [{"data": payload}]])
    funded = rpc(CORE, "fundrawtransaction", [raw])["hex"]
    signed = rpc(CORE, "signrawtransactionwithwallet", [funded])["hex"]
    rpc(CORE, "sendrawtransaction", [signed])
    return mine(CORE, 1, caddr)[0]


def mines_knots(block_index):
    """True if this block should be mined by Knots, spreading KNOTS_PER_100 evenly across each 100."""
    if KNOTS_PER_100 <= 0:
        return False
    slot = block_index % 100
    # evenly spread the Knots slots across the century
    return (slot * KNOTS_PER_100) // 100 != ((slot - 1) * KNOTS_PER_100) // 100


def main():
    log(f"config: interval={INTERVAL}s fork_at={FORK_AT} pre_fork={PRE_FORK_BLOCKS} "
        f"knots_per_100={KNOTS_PER_100}")
    wait_rpc()
    ensure_wallet(CORE)
    ensure_wallet(KNOTS)
    caddr = rpc(CORE, "getnewaddress")
    kaddr = rpc(KNOTS, "getnewaddress")

    # Phase A: activate RDTS on Knots (needs majority signaling -> burst-mine on Knots) + fund Core.
    if not rdts_active():
        log("activating RDTS on Knots (burst-mining bit-4 signaling blocks)...")
        while not rdts_active():
            mine(KNOTS, 10, kaddr)
    log(f"RDTS active (Knots height {h(KNOTS)})")
    if core_mature_balance() < 1.0:
        log("funding Core (101 blocks to a Core address)...")
        mine(CORE, 101, caddr)

    height = h(CORE)
    fork_h = FORK_AT if FORK_AT > height else height + PRE_FORK_BLOCKS
    forked = is_forked()
    log(f"steady state at height {height}; FORK SCHEDULED AT {fork_h}; already_forked={forked}")

    # Phases B–D: one steady-state loop at the hashrate ratio.
    n = 0
    while True:
        try:
            if not forked and h(CORE) >= fork_h - 1:
                viol = mine_violating_block(caddr)
                forked = True
                log(f"*** FORK *** Core mined RDTS-violating block {viol} at {h(CORE)}; "
                    f"Knots stays at {h(KNOTS)}")
            else:
                n += 1
                if mines_knots(n):
                    mine(KNOTS, 1, kaddr)
                    who = "knots"
                else:
                    mine(CORE, 1, caddr)
                    who = "core"
                if n % 25 == 0:
                    log(f"[{who}] Core h={h(CORE)} Knots h={h(KNOTS)} "
                        f"{'depth=' + str(h(CORE) - h(KNOTS)) if forked else '(agreed)'}")
        except Exception as e:
            log("mining error (continuing):", e)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
