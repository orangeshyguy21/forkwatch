# Forkwatch

Live visualization of the **BIP-110 (RDTS) soft-fork race** between Bitcoin **Core** (does not
enforce RDTS) and Bitcoin **Knots** (enforces BIP-110). Two pruned, Tor-only, blocks-only nodes feed
a Rust backend + SQLite cache; a React/Tailwind frontend renders a vertical blockchain — one chain
when the nodes agree, a visible fork when they diverge.

> Self-hosted on the LAN at **http://forkwatch.local** (mainnet). See [LAN access](#lan-access).
> (Formerly "Forkwars"; renamed 2026-07-21. Internal Docker volume names and `forkwars.db` were kept
> to preserve data — see the rename notes in the project memory.)

**Start here:** [`PLAN.md`](./PLAN.md) — full architecture, node config, data model, API, and roadmap.

## Status

**Regtest demo + mainnet stack both working — ✅** (Phases 0–6, minus polish).

- **Regtest** (`:8080`): two peered nodes (Core v31.1, Knots v29.3.knots20260508, RDTS active) + a
  continuous miner that grows a shared chain and **forks at a preprogrammed height**, then keeps both
  chains advancing. The app shows agreement, a fork countdown, and the live two-lane fork with the
  Core block flagged `INVALID` / `REJECTED BY KNOTS`.
- **Mainnet** (`:8081`): `tor` + two pruned, blocks-only nodes syncing the **real chain over Tor**
  (P2P only), bootstrapped from the assumeutxo snapshot at height 840,000; same app. Shows real blocks
  with real RDTS `WOULD VIOLATE` verdicts on data-heavy blocks, real bit-4 signaling %, and a
  `SYNCING` state (distinct from a real fork) while nodes catch up.
- **Backend**: Rust/axum, **SQLite persistence**, prune-aware **backfill from tip → backwards**, hard
  stop at the node prune height, WS live updates.

- **Header countdown**: a seven-segment clock counting down to the height where the chain can
  actually split — see [Countdown](#countdown).

Still deferred: UI polish, RDTS input-side rules 3–7 (need prevouts), the later activation milestones
(lock-in 963,648 / active 965,664), and node↔node peering on mainnet (they currently sync
independently over Tor). See `PLAN.md` §10.

## Countdown

The header's centrepiece is a countdown to `FORK_AT_HEIGHT` — on mainnet **961,632**, the
start of BIP-110's mandatory-signaling window, from which BIP-110 nodes reject blocks that do not
signal bit 4. On regtest it is the demo miner's staged fork height, pinned to that same 961,632 (see
[Run the demo](#run-the-demo-regtest)).

Estimated in `frontend/src/eta.ts`. Measuring the block rate:

- header timestamps are median-filtered (miners need only beat the median of the previous 11, so the
  series can step backwards — real mainnet samples routinely contain negative intervals);
- the interval is a **recency-weighted mean** (24-block half-life) so it tracks current hashrate.

**The horizon is then split at the next difficulty retarget.** The measured rate only predicts blocks
still mined under today's difficulty; past that boundary the protocol drags the interval back toward
`TARGET_SPACING_SECS` (600s), so extrapolating a measured rate through it is simply wrong. A 12%
hashrate blip carried across 2,000 blocks moves a three-week countdown by two days — and the retarget
would have erased it. With `TARGET_SPACING_SECS` unset the whole horizon uses the measured rate,
which is correct on regtest where difficulty never binds.

Uncertainty is three independent terms added in quadrature:

| term | size | scales like |
|---|---|---|
| Poisson — the blocks' own randomness | `√n · σ` | shrinks as `1/√n` relative to the mean |
| rate — how well we know `m` | `n · m / √n_eff` | **constant** relative to the mean |
| drift — hashrate the retarget has not corrected | `n · target · 5%` | constant |

The rate term is the one that matters and the one an earlier version omitted, which left the band
~7× too narrow on a three-week countdown: the EWMA's effective sample size is only ~67, so its own
standard error is ~12%, worth ±2.3 days on a 19-day estimate. A Gamma is fitted to the resulting mean
and sd, so the band stays skewed like reality — tight `14s–16s` for regtest's fixed-cadence miner,
`1m 34s–25m` for one mainnet block.

An absolute **ETA timestamp** is shown alongside, in the viewer's own locale and timezone.

Below **10 blocks** remaining the clock cross-fades out and a plain block count takes over — a time
estimate over a handful of blocks is mostly noise.

The digits (`frontend/src/components/SegmentClock.tsx`) are drawn as SVG polygons rather than set in
a font: seven bars per digit with their ends cut at 45° so neighbours mitre into a clean 90° corner,
and unlit segments left faintly visible so the panel reads as a physical LCD.

### What counts as a split

A **chain split** is the two nodes holding blocks *at the same height with different hashes*. One
node merely being behind is not a split. `/api/state` reports these separately:

| field | meaning |
|---|---|
| `split` | competing blocks at the same height — the real thing |
| `rejected` | Knots marked Core's tip invalid but has no rival block at that height yet |
| `syncing` | one node is simply behind on the same chain |

This matters on mainnet, where the two nodes briefly disagree on nearly every block as one hears it
first; only `split` retires the countdown.

## LAN access

The mainnet stack serves the app on the local network at **http://forkwatch.local** (HTTP, port 80):

- `nginx` reverse-proxy container (`fw-nginx-main`, `compose/nginx/forkwatch.conf`) → `app:8080`,
  passing the `/ws` WebSocket. Port `:8081` stays mapped for local debugging.
- `mdns` container (`fw-mdns-main`, built from `mdns/`) advertises `forkwatch.local` via the host's
  avahi daemon. It runs `network_mode: host`, `pid: host`, mounts the host D-Bus socket, and runs
  **`apparmor=unconfined`** (Ubuntu's default docker AppArmor profile otherwise blocks D-Bus).

`.local` resolves natively on macOS/iOS/Linux; **Windows needs Bonjour**, Android is spotty — for full
coverage add a `forkwatch.lan` A-record on your router / Pi-hole. A DHCP reservation for the host IP is
recommended so the advertised address is stable.

## Run the mainnet stack

```bash
docker compose -f compose/docker-compose.mainnet.yml up -d   # tor + 2 nodes + app + nginx + mdns
# open http://forkwatch.local  (or http://localhost:8081)
```
Nodes sync over Tor (hours): headers first, then `loadtxoutset` at height 840,000, then forward block
sync. Check progress:
```bash
docker exec fw-core-main  bitcoin-cli -datadir=/data getblockchaininfo | grep -E "blocks|headers|pruneheight"
docker exec fw-knots-main bitcoin-cli -datadir=/data getblockchaininfo | grep -E "blocks|headers|pruneheight"
docker logs -f fw-core-main   # watch sync / snapshot load
```

### Node tuning is env-driven — never edit the tracked configs per host

`dbcache`, `onlynet` and `dnsseed` are **not** set in `nodes/*/mainnet.conf`. They vary per
deployment, and hand-editing a tracked file on a server leaves its working tree dirty so the next
`git pull` clobbers the tuning. Set them in `compose/.env` instead — the entrypoint writes them to
`/data/local.conf`, which the tracked conf pulls in via `includeconf` (same mechanism as the RPC
hash):

| Variable | Default | Notes |
|---|---|---|
| `FW_NODE_DBCACHE` | `450` | MiB. Must agree with `FW_NODE_MEM_LIMIT`. Biggest IBD lever. |
| `FW_NODE_ONLYNET` | `onion` | `onion` (private) / `ipv4` (much faster, exposes host IP to peers) / `ipv4,onion` / empty for all. |
| `FW_NODE_DNSSEED` | `0` | Needed to discover clearnet peers; pointless under `onlynet=onion`. |

Defaults reproduce the Tor-only posture, so a fresh clone behaves as documented. For a first sync,
a large `dbcache` plus clearnet is dramatically faster — see `compose/.env.prod.example` for the
measured numbers and the memory caveat (sync one node at a time if you raise it far).

## Clearing the DB (for testing backfill)

```bash
bash scripts/clear-db.sh regtest   # or: mainnet
```
Wipes the app's SQLite and restarts it so it re-backfills from the node tips.

## Run the demo (regtest)

Requires Docker (the `docker` group is active in the base shell, so plain `docker` works).

```bash
cd forkwatch
bash scripts/regtest.sh reset      # ONCE — mines the full chain (hours), ends with a snapshot
bash scripts/regtest.sh restore    # thereafter — back to the parked pre-fork tip in ~20 seconds
# → open http://localhost:8080 and watch the countdown run down to the fork
```

The regtest chain is a **full-scale mirror of the mainnet deployment**: the same heights, on the
same 2016-block retarget boundaries, only the clock runs faster. The fork is pinned at **961632 —
the first block of epoch 477** (961632 = 477 × 2016) — with the app's floor 17 epochs below it at
**927360**, exactly as configured for mainnet in `compose/.env`. Every height, epoch index and ETA
the app computes on regtest is the literal number it will compute in production.

`scripts/regtest.sh reset`:
1. wipes the chain and the app DB, then activates RDTS on Knots and funds Core's wallet **at
   height ~450**. This is the only place funding can happen: the regtest subsidy halves every 150
   blocks and is 0 by ~4950, so a coinbase mined near the fork cannot pay for the violating tx;
2. bulk-mines up to `FLOOR_HEIGHT - 1` in large batches to a wallet-less burn address (~900k
   blocks) — below the app's floor, so speed over fidelity;
3. mines the visible window — the floor block itself upward — one block at a time, dated
   `BLOCK_SPACING_SECS` apart and split at the Knots hashrate ratio, ending at *now*;
4. parks the tip `LEAD_BLOCKS` below the fork, waits for the app to finish backfilling, and saves
   the whole thing as the `prefork` snapshot;
5. hands over to the live miner, which walks the rest in real time, mines the RDTS-violating block
   at `FORK_AT_HEIGHT`, and then keeps **both** chains advancing (Core ahead on its Knots-invalid
   branch, Knots on its valid minority chain).

Blocks are dated with `setmocktime`: regtest rejects timestamps >2h in the future, so a chain of
this size cannot be mined on the real clock at all — and dating them deliberately is what makes the
app's spacing measurement and ETA behave as they will on mainnet. The clock is anchored so that the
**parked tip lands at *now*** and every block below it is one `BLOCK_SPACING_SECS` earlier.

### Snapshots — don't mine it twice

Mining 961,632 blocks takes a couple of hours, which is the wrong thing to repeat every time you
want to watch the fork happen. So `reset` ends by tarring the three docker volumes (both node
datadirs and the app's SQLite, ~3.5 GB) into `snapshots/regtest/prefork/`, and `restore` puts them
back — chain, wallets, RDTS state, backfilled database and all — in about 20 seconds.

```bash
bash scripts/regtest.sh restore              # rewind to the parked pre-fork tip; fork re-armed
bash scripts/regtest.sh snapshot forked      # keep a post-fork state to come back to as well
bash scripts/regtest.sh snapshots            # list them with heights and sizes
bash scripts/regtest.sh snapshot-rm forked
```

The stack is stopped for the duration of both operations: copying a live bitcoind datadir captures
leveldb mid-write, and the node that comes back from that tarball is corrupt in ways that only
surface later. One caveat on `restore` — the restored tip is dated when the snapshot was *taken*,
but the miner resumes on the real clock, so a day-old snapshot leaves one outsized gap between the
parked tip and the first live block. `restore` says so when it notices.

### Tuning it

All parameters live in **`compose/regtest.env`** — fork height, block spacing, lead window, visible
epochs, Knots hashrate, violation size. Edit and re-reset, or override per run:

```bash
bash scripts/regtest.sh reset FORK_AT_HEIGHT=0 VISIBLE_EPOCHS=2      # quick ~6k-block throwaway chain
bash scripts/regtest.sh reset LEAD_BLOCKS=20 BLOCK_SPACING_SECS=5    # a fork ~2 minutes after restore
bash scripts/regtest.sh reset KNOTS_PER_100=10                       # 10% BIP-110 hashrate
bash scripts/regtest.sh status                                       # heights, RDTS, countdown, params
bash scripts/regtest.sh fork-now                                     # stop waiting; fork at the next block
bash scripts/regtest.sh logs                                         # follow the miner
```

`FORK_AT_HEIGHT` must be a multiple of `RETARGET_INTERVAL` — the build refuses a value that would
fork mid-epoch rather than discovering it two hours in. Setting it to **0** restores the old
behavior: derive both heights from wherever RDTS activation happened to land, giving a chain that
resets in a couple of minutes when you are iterating on something that is not height-dependent.
`FLOOR_HEIGHT` is always derived (`FORK_AT_HEIGHT - VISIBLE_EPOCHS × RETARGET_INTERVAL`) and written
to `compose/.regtest.runtime.env`, which the compose file reads.

Note that `fork-now` moves the fork to the current tip, so it trades the pinned 961632 for
immediacy. To keep the real height and still shorten the wait, reset with a smaller `LEAD_BLOCKS`.

> **Known mirror gap:** the signaling gauge reads 0% on regtest. BIP9 blocks stop setting the
> version bit once a deployment is ACTIVE, and RDTS has to be active for Knots to enforce it and
> fork. Mainnet is still *in* its signaling window, so its gauge moves.

Node-level fork check only (no app/miner): `bash e2e/run.sh` →
`PASS ✅  Core accepted the violation; Knots rejected it (status=invalid). Fork reproduced.`
Manual single-fork trigger (if the miner is disabled): `bash e2e/trigger_fork.sh`.

Stop everything: `docker compose -f compose/docker-compose.regtest.yml down`
(add `-v` to also wipe the regtest chain).

### RDTS on regtest (discovered recipe)
- Enable enforcement on Knots: `consensusrules=rdts` in its `bitcoin.conf`.
- Activate the deployment (regtest defaults it to `NEVER_ACTIVE`): `vbparams=reduced_data:0:<max>` on
  Knots **only**, then mine bit-4-signaling blocks on Knots (ACTIVE by height ~432). Core needs no flag.
