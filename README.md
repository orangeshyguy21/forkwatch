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

Still deferred: UI polish, RDTS input-side rules 3–7 (need prevouts), mainnet activation-countdown
math, and node↔node peering on mainnet (they currently sync independently over Tor). See `PLAN.md` §10.

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
bash e2e/demo.sh    # reset + build + start nodes, app, and the continuous miner
# → open http://localhost:8080 and watch:
```

A **continuous miner** (`miner/` service) drives the whole timeline automatically:
1. activates RDTS on Knots, then mines a shared chain at ~1 block / 5 s — the app shows **IN
   AGREEMENT** with a **`FORK SCHEDULED AT #560 — N blocks to go`** countdown;
2. at the preprogrammed height (`FORK_AT_HEIGHT`, default **560**) it mines an RDTS-violating block on
   Core — Core accepts it, Knots rejects it → **FORK**;
3. afterwards it keeps **both** chains advancing (Core ahead on its Knots-invalid branch, Knots on its
   own valid minority chain), so the fork stays live and widens.

Watch the miner: `docker logs -f fw-miner`. Tune cadence/fork height via the `miner`
(and matching `app`) env in `compose/docker-compose.regtest.yml` (`MINE_INTERVAL_SECS`,
`FORK_AT_HEIGHT`).

Node-level fork check only (no app/miner): `bash e2e/run.sh` →
`PASS ✅  Core accepted the violation; Knots rejected it (status=invalid). Fork reproduced.`
Manual single-fork trigger (if the miner is disabled): `bash e2e/trigger_fork.sh`.

Stop everything: `docker compose -f compose/docker-compose.regtest.yml down`
(add `-v` to also wipe the regtest chain).

### RDTS on regtest (discovered recipe)
- Enable enforcement on Knots: `consensusrules=rdts` in its `bitcoin.conf`.
- Activate the deployment (regtest defaults it to `NEVER_ACTIVE`): `vbparams=reduced_data:0:<max>` on
  Knots **only**, then mine bit-4-signaling blocks on Knots (ACTIVE by height ~432). Core needs no flag.
