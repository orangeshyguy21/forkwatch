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
signal bit 4. On regtest it is the demo miner's staged fork height, derived per reset (see [Run the demo](#run-the-demo-regtest)).

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

## Clearing the DB (for testing backfill)

```bash
bash scripts/clear-db.sh regtest   # or: mainnet
```
Wipes the app's SQLite and restarts it so it re-backfills from the node tips.

## Run the demo (regtest)

Requires Docker (the `docker` group is active in the base shell, so plain `docker` works).

```bash
cd forkwatch
bash scripts/regtest.sh reset    # wipe, rebuild the chain, start nodes + app + miner
# → open http://localhost:8080 and watch the countdown run down to the fork
```

The regtest chain is a **scaled mirror of the mainnet deployment**, rebuilt from scratch on every
reset. Same structure as mainnet — floor and fork heights both on 2016-block retarget boundaries,
a full retarget epoch of history below the fork, blocks dated an exact interval apart — with
smaller numbers, so heights, epochs and ETAs exercise the same code paths in minutes rather than
the ~3 hours a real 961,632-block chain would take to mine.

`scripts/regtest.sh reset`:
1. wipes the chain and the app DB, then activates RDTS on Knots and funds Core's wallet **at
   height ~450**. This is the only place funding can happen: the regtest subsidy halves every 150
   blocks and is 0 by ~4950, so a coinbase mined near the fork cannot pay for the violating tx;
2. bulk-mines up to `FLOOR_HEIGHT` (the first retarget boundary above the activation burst) —
   below the app's floor, so speed over fidelity;
3. mines the visible window one block at a time, dated `BLOCK_SPACING_SECS` apart and split at the
   Knots hashrate ratio, ending at *now*;
4. parks the tip `LEAD_BLOCKS` below the fork and hands over to the live miner, which walks the
   rest in real time, mines the RDTS-violating block at `FORK_AT_HEIGHT`, and then keeps **both**
   chains advancing (Core ahead on its Knots-invalid branch, Knots on its valid minority chain).

Blocks are dated with `setmocktime`: regtest rejects timestamps >2h in the future, so a chain of
thousands of blocks cannot be mined on the real clock at all — and dating them deliberately is what
makes the app's spacing measurement and ETA behave as they will on mainnet.

### Tuning it

All parameters live in **`compose/regtest.env`** — block spacing, lead window, visible epochs,
Knots hashrate, violation size. Edit and re-reset, or override per run:

```bash
bash scripts/regtest.sh reset LEAD_BLOCKS=20 BLOCK_SPACING_SECS=5   # a fork in ~2 minutes
bash scripts/regtest.sh reset KNOTS_PER_100=10                      # 10% BIP-110 hashrate
bash scripts/regtest.sh status                                      # heights, RDTS, countdown, params
bash scripts/regtest.sh fork-now                                    # stop waiting; fork at the next block
bash scripts/regtest.sh logs                                        # follow the miner
```

`FORK_AT_HEIGHT` and `FLOOR_HEIGHT` are **derived** by the reset (RDTS activation lands on an
unpredictable height; both are the retarget boundaries above it) and written to
`compose/.regtest.runtime.env`, which the compose file reads.

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
