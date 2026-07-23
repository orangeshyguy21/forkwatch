# Forkwars — Implementation Plan

A live visualization of the **BIP-110 (RDTS) soft-fork race**: two Bitcoin nodes — latest
**Core** (does *not* enforce RDTS) and latest **Knots** (*does* enforce RDTS/BIP-110) — running
side by side, with a web app that renders their chain tips as a single vertical chain when they
agree and a visible **fork** when they diverge.

> Status: **built & running.** Regtest fork demo is green end-to-end; mainnet stack is syncing the real
> chain over Tor. Phases 0–6 complete. The frontend was subsequently rebuilt as a bespoke **isometric
> chain visualizer** (§5.7), and the backend gained **rust-bitcoin raw-block parsing**, **aggregated
> RDTS violations**, off-critical-path startup, and a **configurable mainnet floor** (Phase 7). This
> document is the spec **and** the live progress log; passages tagged *(superseded)* record the original
> plan where the shipped implementation diverged.
>
> Last updated: 2026-07-17.

---

## 1. Background & why the design is shaped this way

**BIP-110 ("Reduced Data Temporary Softfork", RDTS)** is a ~1-year *soft* fork that caps arbitrary
data in transactions (most outputs ≤34 bytes, `OP_RETURN` ≤83 bytes, data pushes ≤256 bytes,
only witness v0 + Taproot spendable during deployment, annex/large control blocks/some opcodes
restricted; inputs spending pre-activation UTXOs are permanently exempt).

- **Authored Dec 3, 2025** (BIP9-modified deployment; start time ~Dec 1, 2025 ≈ block ~925,000).
- Signaling is **BIP9-modified on bit 4**, threshold 1109/2016 (55%), NO_TIMEOUT with a max
  activation height. Mandatory signaling window blocks **961,632–963,647**, LOCKED_IN by **963,648**,
  **ACTIVE at 965,664** (~Sept 1, 2026), active for 52,416 blocks (~1 year). Signaling is currently
  low (<1% as of July 2026).
- Latest **Bitcoin Knots** enforces RDTS since **v29.3.knots20260508** — so the "BIP-110 node" is
  just mainline Knots, no third-party fork binary required.

### The seven RDTS consensus rules (from the BIP) — we implement these for per-block labeling

1. **scriptPubKey limit:** output scriptPubKeys >34 bytes are invalid, unless the first opcode is
   `OP_RETURN` (then up to 83 bytes are valid). *(creation-side — always applies once active)*
2. **Data push limit:** `OP_PUSHDATA*` payloads and script-argument witness items >256 bytes are
   invalid, except the redeemScript push in BIP16 scriptSigs. *(output pushes = creation-side; witness
   items = input-side)*
3. **Witness version restriction:** spending undefined witness/tapleaf versions (not v0/BIP141,
   Taproot/BIP341, or P2A) is invalid. *(input-side)*
4. **Taproot annex:** witness stacks with a Taproot annex are invalid. *(input-side)*
5. **Control block size:** Taproot control blocks >257 bytes are invalid. *(input-side)*
6. **OP_SUCCESS restriction:** tapscripts containing `OP_SUCCESS*` anywhere (even unexecuted) are
   invalid. *(input-side)*
7. **Conditional opcodes:** tapscripts executing `OP_IF`/`OP_NOTIF` are invalid. *(input-side)*

**Exemption:** inputs spending UTXOs created *before* activation are permanently exempt from these
rules. Consequence for our labeling: for **pre-activation / historical blocks the input-side rules
(2-witness, 3–7) are all exempt**, so a block's "would-violate" signal comes almost entirely from the
**creation-side rules (1 and 2-outputs)** — i.e. oversized scriptPubKeys, big `OP_RETURN`, and large
data pushes (the inscription/Runes/BRC-20 payloads BIP-110 targets). Post-activation we evaluate all
seven properly.

**The key insight that drives the whole architecture:** because RDTS is a *soft* fork, the race is
**most-work chain (Core)** vs **most-work RDTS-*valid* chain (Knots)**. If a block violating the
RDTS rules gets mined and BIP-110 does not hold majority hashpower:

- **Core** accepts it and builds on it (its tip advances).
- **Knots** rejects it as invalid and stays on / follows a different tip.

Crucially, if the two nodes are peered, Core will forward the offending block to Knots, and Knots
will list Core's branch in `getchaintips` with `status: "invalid"`. **That `getchaintips` diff is
our primary fork-detection data source** — we don't have to infer the fork, the nodes tell us.

Pre-activation and while everyone follows the rules, both tips are identical → single chain.
The app is essentially a purpose-built differential block explorer for these two nodes.

---

## 2. High-level architecture

```
                          Tor (onion-only, blocksonly)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
  ┌───────────┐               ┌───────────┐                     │
  │ bitcoind  │               │  knotsd   │   (optionally peered │
  │  (Core)   │◄── addnode ──►│ (Knots +  │    to each other so  │
  │  pruned   │               │  BIP-110) │    Knots sees Core's │
  │  blocksonly│              │  pruned   │    invalid branch)   │
  └─────┬─────┘               └─────┬─────┘                     │
    RPC │ + ZMQ hashblock       RPC │ + ZMQ hashblock           │
        │                           │                           │
        └─────────────┬─────────────┘                           │
                      ▼                                         │
             ┌──────────────────┐                              │
             │  Rust backend    │  poll on ZMQ notify + fallback timer
             │  (axum + tokio)  │  → getchaintips / getblock both nodes
             │                  │  → diff → write SQLite → broadcast WS
             │  SQLite (block   │
             │  cache)          │
             └────────┬─────────┘
                REST + WebSocket
                      ▼
             ┌──────────────────┐
             │ React + Tailwind │  vertical chain, tip on top,
             │  frontend        │  scroll down for history, fork view
             └──────────────────┘
```

All components run under **one `docker compose`** stack. Node containers reach the Bitcoin network
**only over Tor** (`onlynet=onion`, `proxy=tor:9050`, `listenonion=1`). The backend/frontend talk
to the nodes over the internal Docker network only (never exposed publicly).

---

## 3. Node setup

**Pinned versions (latest as of July 2026):**
- **Core:** `v31.1` (released 2026-07-08). *Never enforces RDTS* — RDTS is a Knots-only soft fork, so
  Core is our "accepts everything" side by construction.
- **Knots:** `v29.3.knots20260508` (first/only RDTS-enforcing mainline Knots). It **asks for explicit
  confirmation before applying RDTS**, so in a headless container we must enable RDTS non-interactively
  via config/flag — **to-verify exact option** (§11). This is the RDTS-enforcing side.

**Two environments, one app** (see §6, §9, §10a):
- **`regtest` (e2e/dev):** both nodes on regtest, no Tor, no pruning, no snapshot; a test driver mines
  blocks and crafts RDTS-violating txs to **force the fork on demand** — the only way to exercise the
  real fork behavior before mainnet actually forks.
- **`mainnet` (production):** pruned, blocksonly, Tor-only, `loadtxoutset` from `utxo-840000.dat`,
  peered. The backend/frontend code is **identical** across both; only a `ChainConfig` (network,
  RDTS activation height, signaling bit, epoch size) and the compose file differ.

### 3.1 Shared node config (both Core and Knots) — mainnet/production

- **`prune=` sized to retain ≥1 year of block *bodies*.** We *must* keep bodies for the scrollback
  depth because per-block RDTS labeling (requirement B) needs to read each block's transactions. The
  prune window *is* the scrollback horizon ("as far back as the nodes have blocks"). Recommended
  **`prune=150000` (~150 GB) per node** → ~18–20 months of bodies, comfortably back past BIP-110's
  authoring (Dec 2025 ≈ block 925k) and a full year (~block 905k). Two nodes ≈ 300 GB bodies + ~12 GB
  chainstate each + SQLite; fits easily in the 828 GB free. Make prune size an env knob. (`loadtxoutset`
  forces ≥1100 MiB pruning regardless.) Once a block is scanned, its RDTS verdict lives in SQLite, so
  the verdict survives even after the body is eventually pruned below the horizon.
- `blocksonly=1` — no tx relay / no mempool. We only care about blocks; smaller footprint, less Tor
  traffic. (Trade-off: we cannot show unconfirmed txs or "which mempool txs violate RDTS". Acceptable
  per requirements. Revisit only if we later want a mempool view.)
- Tor only: `onlynet=onion`, `proxy=tor:9050`, `bind=...:onion`, `listenonion=1`, `dns=0`,
  `dnsseed=0` (use `onion` seeds / hardcoded onion `addnode`s).
- RPC: `server=1`, `rpcbind`, `rpcallowip` restricted to the Docker subnet, cookie or
  user/pass auth (per-node credentials via env/secret).
- **ZMQ**: `zmqpubhashblock=tcp://0.0.0.0:28332` (+ `zmqpubhashtip` if available) so the backend gets
  pushed on every new block/tip change instead of only polling.
- `txindex=0` (not needed; we never do arbitrary tx lookups — see §7 RPC-vs-Electrum).

### 3.2 Fast bootstrap via assumeutxo (the "utxo dump")

The user can provide a UTXO snapshot. On first run, per node:

1. Start node (it begins headers sync over Tor).
2. `loadtxoutset /snapshots/utxo-840000.dat` → node builds a snapshot chainstate at height 840,000 and
   becomes usable to the tip once it downloads 840,001→tip over Tor (~118k blocks; slower than a more
   recent snapshot but universally supported), while background-validating genesis→840,000.
3. Works fine on pruned nodes; snapshot file can be deleted after load to save space.

**Snapshot: settled on height 840,000.** File in place and verified:
`snapshots/utxo-840000.dat` (9.2 GB) — valid `utxo\xff` v2 mainnet snapshot, base block height 840,000
(hash `…1cda83a5`, confirmed against the chain). Height 840,000 is hardcoded in **both** Core (since
v28, so v31.1 has it) and the RDTS Knots build (`v29.3.knots20260508` chainparams carry 840k/880k/910k),
so `loadtxoutset` accepts it on both nodes. (910,000 would sync-to-tip faster and is also supported by
both; 840,000 chosen as the safest/most-universal — revisit only if Tor sync speed is a problem.)

Both nodes mount `./snapshots` **read-only** and run `loadtxoutset /snapshots/utxo-840000.dat` on first
start (one shared file). The file may be deleted after both nodes finish loading.

> Note: the snapshot height only affects *bootstrap speed*, not scrollback depth. Scrollback depth is
> the **prune window** (§3.1), which we size to cover ≥1 year regardless of snapshot height.

### 3.3 Peering the two nodes (recommended, configurable)

- Each node connects to the real network over Tor (independent peer sets → realistic divergence).
- **Additionally** `addnode` the two containers to each other. This makes Knots receive Core's blocks
  even when they violate RDTS, so Knots can mark Core's branch `invalid` in `getchaintips` — giving us
  a *fully described* fork (both sides + validity) instead of just "Knots is missing a block".
- Make this a compose/env toggle (`PEER_NODES=true|false`) so we can demo both behaviors.

---

## 4. Backend (Rust)

**Crates:** `axum` (HTTP + WS), `tokio`, `bitcoincore-rpc` (works against Knots too — same RPC
surface), `rusqlite` (or `sqlx` w/ SQLite) for the cache, `zmq`/`tmq` for ZMQ block notifications,
`bitcoin` (rust-bitcoin — parse blocks/txs/witness/scripts for the RDTS checker), `serde`, `tracing`.

### 4.1 Responsibilities

1. **Ingest loop** *(shipped as a single polling thread, not ZMQ — see note)*:
   - Poll both nodes on a timer (`POLL_MS`, regtest 2 s / mainnet 5 s):
     - `getblockchaininfo` / `getnetworkinfo` / `getchaintips` / `getdeploymentinfo`, and — for each
       new/branch tip — the **raw block** via `getblock <hash> 0`, decoded with **rust-bitcoin**
       (`bitcoin::consensus::deserialize::<Block>`) instead of verbose JSON. One decode yields height,
       hash, prevhash, time, size/weight, nTx, **version** (bit-4 signaling), and the full tx set for
       the RDTS scan. *(Updated — the plan originally used `getblock 2`; raw parsing is materially
       faster and removed the heavy JSON round-trip. ZMQ was dropped in favor of polling.)*
   - **Signaling label (req A):** a block signals BIP-110 iff `(version & 0x20000000) != 0 &&
     (version & (1 << 4)) != 0`. Store per block.
   - **RDTS content verdict (req B):** run the RDTS checker (§4.4) over the block's transactions →
     `pass` / `would_violate` (pre-activation) or `pass` / `invalid` (post-activation, matching what
     Knots actually enforces). Store the verdict + **violations aggregated by `(rule, kind)` with a
     count** (not per-txid — the UI shows "scriptPubKey > 34 bytes ×N").
   - Upsert blocks + per-node observations into SQLite. Detect reorgs (prev tip no longer on active
     chain) and fork branches (from `getchaintips` entries with status
     `active` / `valid-fork` / `headers-only` / `invalid`).
   - **Backfill task:** on startup, walk backward from each node's tip to the prune horizon, scanning
     any blocks not yet in SQLite (signaling + RDTS verdict), so the infinite-scroll history is fully
     labeled. Bounded/rate-limited so it doesn't starve live ingest.
2. **Diff/state engine:** compute the unified view — for each height, do both nodes agree on the hash?
   Where is the lowest common ancestor? Which branch does each node consider active, and what status
   does each assign to the *other's* tip? Emit a `ChainState` snapshot.
3. **Aggregations:** maintain per-epoch (2016-block) signaling tallies for the minimap and a rolling
   average block interval (from recent block header times) for the countdown ETAs; recompute the
   affected epoch + countdown on each new block. (Both derive from the `block` table, so a restart
   rebuilds them from SQLite.)
4. **Broadcast:** push `ChainState` deltas, signaling/countdown updates to WebSocket clients; serve
   history via REST.

### 4.2 SQLite schema — **as shipped** *(simplified from the draft below)*

The shipped cache is a **single `block` table**; violations are stored inline as aggregated JSON, so
there is no separate `block_violation` table. Per-node status (`core_status`/`knots_status`) and the
fork/LCA diff are recomputed in memory each poll from the chain maps (not persisted), so the
`node_view`/`chain_event` tables were not needed.

```sql
CREATE TABLE IF NOT EXISTS block (
  hash           TEXT PRIMARY KEY,
  height         INTEGER NOT NULL,
  prev_hash      TEXT,
  time           INTEGER,
  size           INTEGER,
  weight         INTEGER,
  tx_count       INTEGER,
  version        INTEGER,
  signals_110    INTEGER NOT NULL,   -- req A: bit-4 BIP9 signaling (0/1)
  rdts_verdict   TEXT NOT NULL,      -- req B: 'pass' | 'would_violate' | 'invalid' | 'unscanned'
  rdts_rule_hits TEXT,               -- JSON array of rule numbers hit
  violations     TEXT                -- JSON: aggregated Violation[] (see below)
);
```

`Violation = { rule: u8, kind: string, count: i64 }`, aggregated by `(rule, kind)` across the whole
block — e.g. `[{ rule:1, kind:"scriptPubKey > 34 bytes", count:212 }, { rule:1, kind:"OP_RETURN > 83
bytes", count:1 }]`. The UI renders these as "kind ×count" pills; we deliberately do **not** keep
per-txid rows.

<details><summary>Original multi-table draft (superseded)</summary>

```sql
-- block (with median_time, bits, first_seen); block_violation(hash,txid,rule,detail);
-- node_view(node,hash,status,is_tip,observed_at); chain_event(id,ts,node,kind,height,hash,detail)
```
The per-txid `block_violation`, `node_view`, and `chain_event` tables were dropped: violations are
aggregated inline, per-node status is derived in memory, and no persistent event log was required.
</details>

> Pruning caveat: pruned nodes can only serve block bodies they still retain. History deeper than the
> prune window (or below the assumeutxo snapshot until background validation finishes) may be
> header-only or unavailable. The SQLite cache is therefore the **durable** history — we persist what
> we observe going forward; we do not assume we can backfill arbitrarily deep. The vertical scroll is
> backed by SQLite, not by re-querying old blocks from the nodes.

### 4.3 REST + WebSocket API (draft)

- `GET /api/state` — current unified `ChainState` (tips, fork status, LCA height).
- `GET /api/blocks?before=<height>&limit=<n>` — descending page for the infinite scroll (from SQLite),
  each block including `signals_110` and `rdts_verdict`; `has_more` false at the prune horizon.
- `GET /api/blocks/<hash>/violations` — the block's **aggregated** `Violation[]` (`rule, kind, count`)
  for the drill-down drawer. *(Updated — was "offending txids + rules"; violations are now aggregated
  by kind, not per-txid.)*
- `GET /api/blocks/range?from=&to=&chain=core|knots` — ascending window of blocks in a height range,
  skipping gaps; `chain=knots` serves the Knots node's own (minority) chain. Drives the isometric
  window fetch (§5.7). `/api/state` also carries `prune_floor` (the effective floor, §Phase 7) and
  `tip_height` so the UI clamps its scroll correctly.
- `GET /api/events?since=<id>` — chain event log (reorgs/forks) for a side timeline.
- `GET /api/nodes` — each node's version, sync %, peer count, tip height, verificationprogress.
- `GET /api/signaling` — per-epoch (2016-block) tallies for the minimap: `{epoch, height_from,
  height_to, signaled, total, pct, locked_in: pct>=55}` plus the current partial epoch's running
  totals and the 1109/2016 threshold constant.
- `GET /api/countdown` — milestone heights (961,632 mandatory / 963,648 lock-in / 965,664 active),
  current tip height, `blocks_remaining` per milestone, `avg_block_secs` (recent ~2016-block average),
  and derived `eta_secs` per milestone. Also pushed on `new_block` over WS so the header ticks live.
- `WS /ws` — server pushes `state_update` / `new_block` / `fork` / `reorg` / `node_status` /
  `signaling_update` / `countdown` messages.

### 4.4 RDTS checker module (`rdts.rs`) — the heart of requirement B

A pure function `check_block(block, activation_height) -> BlockVerdict` implemented against the seven
rules in §1, using `rust-bitcoin` to parse scripts/witnesses. Per transaction:

- **Rule 1** — for each output: `spk.len() > 34` and not (`spk[0]==OP_RETURN && spk.len()<=83`) → hit.
- **Rule 2 (creation side)** — scan output scripts for `OP_PUSHDATA*` payloads >256 bytes → hit.
- **Rules 2 (witness), 3–7 (input side)** — evaluate only when the spent UTXO was created at/after
  `activation_height` (pre-activation spends are exempt). **Pre-activation blocks: skip input-side
  rules entirely (all exempt).** Post-activation, determine the spent output's age via `getblock`
  verbosity 3 prevouts (or `gettxout`/cache); parse witness for annex (rule 4), control-block size
  (rule 5), tapleaf/witness version (rule 3), tapscript opcodes `OP_SUCCESS*` (rule 6) and executed
  `OP_IF/OP_NOTIF` (rule 7), and witness-item sizes (rule 2).

Block verdict = `pass` if no tx hits any applicable rule; else `would_violate` (pre-activation) or
`invalid` (post-activation). **We always compute and display the would-violate verdict, even though
RDTS isn't enforced yet** — that's the whole point of the visual ("a block like this is going to be
invalid pretty soon"). **Confidence note to surface in the UI:** creation-side rules (1 and
2-outputs — the inscription/Runes/big-data payloads) are *authoritative* "will be invalid" signals,
because a newly-created output like this would be rejected post-activation. Input-side rules (3–7 and
2-witness) carry a caveat: spends of pre-activation UTXOs are permanently exempt, so a today-block
tripping an input-side rule may still be valid after activation. So we mark creation-side hits as
**"will be invalid"** and any input-side hits as **"advisory"** (distinct styling), rather than
overstating. **Sanity cross-check:** post-activation, our `invalid` verdict should match Knots actually
rejecting the block (`getchaintips` status `invalid`) — log mismatches; they mean the checker diverges
from consensus. Ship with **BIP-text-derived unit test vectors** (inscription tx → rule 1/2 hit; clean
payment → pass; annex spend → rule 4; etc.).

`ChainState` (shape):
```jsonc
{
  "agreed": false,
  "lca_height": 965663,          // lowest common ancestor
  "core":  { "tip_hash": "...", "tip_height": 965666, "branch": [ /* hashes above lca */ ] },
  "knots": { "tip_hash": "...", "tip_height": 965665, "branch": [ /* hashes above lca */ ] },
  "knots_view_of_core_tip": "invalid",   // why Knots rejected it
  "fork_since": 1725148800
}
```

---

## 5. Frontend (React + Tailwind)

> **Implementation note:** §5.1–5.6 describe the *original* card/virtualized-list design. That shipped
> in Phase 4/5 and then was **rebuilt as an isometric chain visualizer** — see **§5.7** for the current
> UI. The data contract (REST/WS, badges, verdicts, signaling) carried over unchanged; what changed is
> the rendering (isometric SVG cubes + fisheye scroller instead of a flat card list, and the two-sided
> circuit/Celtic theme was dropped for a cleaner Core-mono / Knots-green look).

### 5.1 Layout & behavior

- **Vertical blockchain**, newest block (chain tip) on **top**, older blocks below. **Dynamic infinite
  scroll**: as the user scrolls down, older pages load from `GET /api/blocks?before=<height>&limit=N`
  (windowed/virtualized list, e.g. `@tanstack/react-virtual`, so thousands of blocks stay smooth).
  Bottom of history = the prune horizon → render a clear "history begins here (nodes pruned below this
  point)" cap. Live updates via WebSocket **prepend** new tips at the top.
- **Agreement state:** a single centered chain (both nodes agree).
- **Fork state:** at the last common ancestor the chain **splits into two lanes** — Core (left) and
  Knots (right) — each rendering its branch; a connector marks the shared ancestor. Knots-rejected
  (`invalid`) blocks are marked distinctly; the RDTS-valid Knots tip is highlighted. Hover/click shows
  *why* (which rule). When one chain out-works and both reconverge → re-merge to the single chain.

### 5.2 Two-sided theme (Core vs Knots identity)

The two identities are **always present**, not only during a fork:

- **Core side (left): "circuit board."** Clean black & white / high-contrast monochrome, thin traces,
  vias, right-angle routing, monospace type. Precise, industrial, minimal.
- **Knots side (right): "Celtic knotwork."** Interwoven knot borders, ornamental corners, a **green**
  palette (moss/emerald), a more organic/serif feel.
- **Single (agreed) chain:** rendered down the center with a **vertical seam** — left half carries a
  subtle circuit motif, right half a subtle knotwork motif — so the shared chain visibly belongs to
  both. When it forks, the seam "tears" into the two fully-themed lanes (nice animated transition).
- Implement as two Tailwind theme scopes (CSS variables / `data-side` attribute) + SVG motif assets
  (tileable circuit trace and knot border). Keep motifs as background/border layers so block content
  stays legible. Respect `prefers-reduced-motion` for the tear/scroll animations.

### 5.3 Block card (per requirements A & B)

Each block shows height, short hash, time, size/weight, tx count, plus badges:

- **Node badges:** Core accepted/tip; Knots accepted/tip/**invalid**.
- **(A) BIP-110 signaling:** a "signals ▲ bit-4" badge when `signals_110` is set (styled toward the
  Knots/green identity since it's pro-RDTS).
- **(B) RDTS content verdict:** a pill —
  - `PASS` (green/knot) — all txs comply with RDTS,
  - `WOULD VIOLATE` (amber, pre-activation) — contains data that RDTS *would* reject, with a count,
  - `INVALID` (red, post-activation) — actually violates active RDTS (Knots rejects it).
  Click → drawer listing offending txids and which of the 7 rules each hit (from `block_violation`).

### 5.4 Top countdown banner (headline, always visible at the very top)

A prominent header counting down to the two fork-risk milestones, **in both time and blocks**:

- **Mandatory signaling** — begins **block 961,632** (blocks 961,632–963,647; non-signaling blocks are
  rejected by RDTS nodes → first real fork-risk point).
- **Activation / potential fork** — LOCKED_IN by **963,648**, **ACTIVE at 965,664** (RDTS-violating
  blocks rejected → the split the app visualizes).
- Each milestone shows **blocks remaining** (`target − current tip height`) and a **best-estimate
  time** (`blocks_remaining × observed avg block interval`, using the recent ~2016-block average, not a
  flat 10 min, so the ETA tracks reality). Display e.g. `MANDATORY SIGNALING · 1,842 blocks · ~12d 20h`.
- A live **signaling gauge**: current retarget period's signaling `%` vs the **55% (1109/2016)**
  threshold — are we on track to lock in? Color shifts as it crosses 55%.

### 5.5 Signaling minimap (side scroll helper)

A slim, full-height **minimap of the entire chain** down one side (a navigable overview + scrollbar):

- One tiny cell per block (or per small bucket when zoomed out), positioned by height; **blocks that
  signaled bit-4 are highlighted** (green/knot accent), non-signaling dimmed.
- **Epoch dividers** at every difficulty-retarget boundary (**2016-block** periods, aligned to
  BIP9 windows), labeled with the epoch's height range.
- **Per-epoch sum totals**: signaled vs not, as a count and `%`, with a marker line at the **55%
  threshold** so you can see which epochs would have locked in. Current (partial) epoch shows running
  totals.
- Clicking/dragging the minimap **jumps the main vertical chain** to that height (drives the same
  virtualized scroll). A viewport indicator shows where you are. The activation target (965,664) and
  the mandatory-signaling window are marked on the minimap too.

### 5.6 Chrome

- **Status bar:** per node — version, sync %, peers, tip height; global "IN AGREEMENT" vs
  "FORKED (N blocks)".
- **Event timeline** (side panel): reorgs and fork events over time.
- Tailwind + a small WS client hook + a `zustand`/context store for chain state.

### 5.7 Isometric chain visualizer — **current UI**

The flat card list was replaced with a videogamey **isometric block chain** (pure SVG cubes, no WebGL),
rendered top-down: newest block up, history receding downward into a fisheye "tunnel."

- **Fisheye focus+context scroller** (`iso.ts` + `hooks/useScrollFocus.ts`): a virtual, rAF-lerped
  focus height drives a log-tunnel layout — the focused block is large and centered; neighbors shrink
  with distance (`sizeFor`), spacing follows the same falloff so there are no dead zones. Velocity
  springs a global zoom for a "flying" feel while scrolling. Wheel / keyboard / scroll-rail all feed the
  same eased target. No native scrollbar.
- **Detent focus (always one focused block):** the focus eases toward the *nearest integer height*
  (`Math.round(target)`), so it never rests between two blocks — exactly one block is THE focus at all
  times. Landing in focus plays a squash-and-stretch **"pop"** (`fw-focus-pop`), and the focused block
  gets an emphasis bump (`focusPop`) plus extra gap to its neighbors (`focusLift`) so its chain links
  read clearly.
- **Isometric cubes** (`IsoBlock.tsx`): 2:1 iso cube with themed faces (Core = mono/graphite, Knots =
  emerald, shared = slate), flank chips that sit *flat on the faces* — a green ▲ signaling chevron and
  an amber/red `!` violation mark — a red edge-glow for Knots-rejected (`invalid`) blocks, and a juicy
  "build from falling pieces" spawn animation when a new tip lands.
- **Chain-link connectors** (`IsometricChain.tsx`): interlocking chain links live **only in the gaps**
  and only on the two segments touching the focused block + the fork junction; every other gap gets a
  simpler tether. Links anchor from a block's **bottom-front corner** down into the **centre of the next
  block's top diamond** (measured iso ratios), so the chain sockets into the top face instead of slicing
  through the (translucent) cubes.
- **Fork rendering:** the single centered column splits into two **parallel vertical lanes** at the LCA
  (Core one side, Knots the other, `LANE_GAP` apart), each fed by that node's own chain
  (`/api/blocks/range?chain=knots` serves the Knots minority branch end-to-end). A short Y-junction of
  chain links branches from the shared fork block up into both lanes. A single centered height label per
  fork row; a "⚔ Forked at #N" banner.
- **Scroll rail** (`ScrollRail.tsx`): a slim focus+context rail with epoch (2016-block) markers, a
  draggable thumb, and TIP / FORK jump buttons — the minimap's role, adapted to the tunnel.
- **Block drawer:** clicking a block **pushes the chain aside** (in-flow panel, view stays usable) and
  shows details + on-demand aggregated violations; at a forked height it shows *both* nodes' blocks.
- **Deep links:** `?focus=<height>` centers a height on load; `?open=<height>` opens its drawer.

---

## 6. Docker Compose topology

**Two compose files sharing the same backend/frontend images**, selected by environment. Common
services factored into a `docker-compose.base.yml`; each env overlays node config + its extras.

### 6.1 `docker-compose.mainnet.yml` (production)

All on an internal bridge network; only the backend port is published to the host:

- `tor` — Tor daemon; SOCKS `9050` on the internal network only.
- `core` — Bitcoin **Core v31.1** (pruned, blocksonly, onion-only); RPC + ZMQ on internal net;
  snapshot mounted read-only for first-run `loadtxoutset`. Peered to `knots`.
- `knots` — Bitcoin **Knots v29.3.knots20260508** (pruned, blocksonly, onion-only, **RDTS enabled
  non-interactively**); separate volume. Peered to `core`.
- `backend` — Rust server (serves the built React bundle too); owns the SQLite volume; env carries both
  nodes' RPC creds + ZMQ addrs + `ChainConfig=mainnet`.

Volumes: `core-data`, `knots-data`, `tor-data`, `app-db`. RPC cookies/passwords via env/Docker secrets.
Resource note: two nodes pruned (`prune≈150000`) + blocksonly ≈ ~150 GB each + chainstate → fits the
828 GB free.

### 6.2 `docker-compose.regtest.yml` (e2e / dev)

- **No `tor`** (regtest is local), **no pruning**, **no snapshot** — the chain is tiny.
- `core` / `knots` — same images, `regtest.conf` (regtest network, RPC+ZMQ, peered, **RDTS forced
  active early on Knots** via deployment override so we don't have to simulate 2016-block signaling).
- `backend` — same image, `ChainConfig=regtest` (short epoch, low activation height).
- `e2e` — a driver container (§10a) that mines blocks, funds a wallet, crafts RDTS-violating txs, and
  runs the fork/reconverge assertions against the nodes **and** the backend API.

Fast to spin up and tear down; this is where the actual fork behavior gets exercised and demoed.

---

## 7. RPC vs Electrum — decision: **JSON-RPC + ZMQ**

We track *chain structure* (tips, branches, per-node validity, block metadata), not
address/scripthash history. Electrum servers (electrs/Fulcrum) exist to index addresses and generally
want `txindex`/full data — heavy and unnecessary here, and they'd obscure the per-node *validity*
information we specifically need. Core's `getchaintips` gives us exactly the fork/branch/validity data,
and ZMQ `hashblock` gives push updates. **Use `bitcoincore-rpc` + ZMQ. No Electrum.**

---

## 8. How the fork actually renders (worked example)

1. Steady state: `core.getbestblockhash == knots.getbestblockhash` → `agreed:true`, single chain.
2. An RDTS-violating block `B` is mined at height H+1. Core accepts → Core tip = `B`.
3. Knots (peered to Core) receives `B`, validates, rejects → `getchaintips` on Knots lists `B` with
   `status:"invalid"`; Knots active tip stays at H (or the next RDTS-valid block).
4. Backend diff: tips differ, LCA = H, Core branch = `[B, ...]`, Knots marks `B` invalid → emit
   `fork` event + `ChainState{agreed:false}`.
5. Frontend splits into two lanes at H; Core lane shows `B` building forward, Knots lane shows `B` as
   invalid and its own RDTS-valid tip. If later one chain out-works and both converge, emit
   `fork_resolved` and re-merge to a single column.

---

## 9. Proposed repository layout

```
forkwars/
├── PLAN.md  README.md
├── .env.example                     # RPC creds, toggles (PEER_NODES, prune size)
├── compose/
│   ├── docker-compose.base.yml      # shared backend/frontend build + network
│   ├── docker-compose.mainnet.yml   # + tor, pruned/blocksonly/onion nodes, snapshot
│   └── docker-compose.regtest.yml   # + regtest nodes + e2e driver (no tor/prune/snapshot)
├── tor/torrc
├── nodes/
│   ├── core/{mainnet.conf, regtest.conf}
│   └── knots/{mainnet.conf, regtest.conf}   # regtest.conf forces RDTS active early
├── backend/                         # Rust (Cargo) — env-agnostic
│   ├── Cargo.toml
│   ├── src/{main.rs,rpc.rs,ingest.rs,rdts.rs,diff.rs,db.rs,ws.rs,api.rs,model.rs,config.rs}
│   ├── config/{mainnet.toml, regtest.toml}  # ChainConfig: network, activation height, bit, epoch
│   ├── migrations/
│   └── Dockerfile
├── frontend/                        # React + Vite + Tailwind (served by backend)
│   ├── package.json
│   └── src/{App.tsx,components/,hooks/useChainSocket.ts,store.ts}
│   └── Dockerfile
├── e2e/                             # regtest fork-scenario driver + assertions (§10a)
│   ├── Cargo.toml (or ts/)
│   └── scenarios/{fork_on_violation.rs, reconverge.rs, signaling.rs}
└── snapshots/utxo-840000.dat        # gitignored
```

---

## 10a. Regtest e2e harness (the fork test bed)

The **only** way to exercise real fork behavior before mainnet forks. Lives in `e2e/`, drives the
`docker-compose.regtest.yml` stack, and doubles as the demo environment and CI integration test.

**Setup:** bring up `core` + `knots` on regtest, peered; force RDTS **active** on the Knots node at a
low height (deployment override — Core-style `-testactivationheight=rdts@<h>` / `-vbparams`, or the
Knots RDTS regtest config — **to-verify §11**); Core never enforces RDTS regardless. Fund a wallet via
`generatetoaddress`.

**Scenario A — fork on violation (`fork_on_violation`):**
1. Mine to a common tip past RDTS activation; assert `core` and `knots` agree.
2. Craft an **RDTS-violating tx** — start with the unambiguous creation-side case: an output with a
   `>83`-byte `OP_RETURN` (rule 1) or a `>256`-byte data push (rule 2). Sign it.
3. Submit + mine it **into a block on the Core node** (Core accepts). Ensure Core is the block's
   producer so its tip includes the violating block `B`.
4. **Assert node behavior:** `core.getbestblockhash` = `B`; `knots.getchaintips` lists `B` with
   `status:"invalid"`; Knots active tip stays below `B`.
5. **Assert app behavior:** backend `/api/state` → `agreed:false`, `lca_height` correct, Core branch
   contains `B`, `knots_view_of_core_tip:"invalid"`; `/api/blocks` shows `B` with `rdts_verdict:invalid`
   and the offending txid+rule in `/api/blocks/<B>/violations`; WS emitted a `fork` event.

**Scenario B — reconverge (`reconverge`):** build an RDTS-valid competing chain that out-works Core's
branch, feed it so both nodes adopt it; assert `agreed:true` again and a `fork_resolved` event.

**Scenario C — signaling (`signaling`):** mine blocks with/without bit-4 set; assert per-epoch
`/api/signaling` tallies and the countdown/threshold math (using regtest's short epoch from ChainConfig).

Each scenario is an assertion script (Rust test harness or TS) runnable locally and in CI. A regtest
"chaos" mode (loop mining random valid + occasional violating blocks) is handy for eyeballing the UI.

**Continuous miner (`miner/` service) — ✅ DONE.** For a live, hands-off demo the stack includes a
Python miner container that: (A) activates RDTS on Knots + funds Core; (B) mines a shared chain at a
steady cadence (`MINE_INTERVAL_SECS`, default 5 s) so the nodes stay **agreed** while the height
climbs; (C) at a **preprogrammed height** (`FORK_AT_HEIGHT`, default 560) mines the RDTS-violating
block on Core → **fork**; (D) then keeps *both* chains advancing (Core on its Knots-invalid branch,
Knots on its own valid minority chain) so the fork persists and widens. The same `FORK_AT_HEIGHT` is
passed to the backend, which exposes `scheduled_fork {height, blocks_until, reached}` in `/api/state`
so the UI shows a "FORK SCHEDULED AT #N — k blocks to go" countdown before the fork. This makes the
before → fork → after story watchable end-to-end via `e2e/demo.sh`.

---

## 10. Phased roadmap (regtest-first)

- **Phase 0 — Regtest infra + e2e skeleton — ✅ DONE:** `compose/docker-compose.regtest.yml` with
  `core v31.1` + `knots v29.3.knots20260508`, peered, RDTS activated on Knots; the `e2e/` driver mines,
  funds, and **produces a violating block that Core accepts and Knots marks `invalid`**. Proven green by
  `e2e/run.sh` (Scenario A, node-level). Fork mechanics confirmed before any app code.
- **Phase 1 — Backend ingest — ✅ DONE:** Rust/axum service (`backend/`), polls both nodes' RPC
  (`getblockchaininfo`/`getnetworkinfo`/`getchaintips`/`getblock 2`/`getdeploymentinfo`), builds an
  in-memory chain model, serves `GET /api/state`, `/api/blocks`, `/api/blocks/:hash/violations`,
  `/api/health`, and a `/ws` push channel. (SQLite persistence deferred — see status note.)
- **Phase 2 — RDTS checker — ✅ (rules 1 & 2):** `backend/src/rdts.rs` implements the creation-side
  rules (1 = oversized scriptPubKey / OP_RETURN > 83; 2 = output data push > 256) + bit-4 signaling.
  Verified: the regtest violating block is labeled `invalid`, rule 1, matching Knots' `invalid` verdict.
  Input-side rules 3–7 still TODO.
- **Phase 3 — Diff engine — ✅ DONE:** LCA + per-node branch + `knots_view_of_core_tip`; agreed vs
  forked `ChainState`; WS broadcast on change (live fork transition confirmed in ~2–3 s).
- **Phase 4 — Frontend core — ✅ DONE:** `frontend/` (Vite+React+TS+Tailwind) — vertical chain,
  IntersectionObserver infinite scroll, live WS updates, node status bar, signaling gauge, RDTS status,
  block badges + violation drill-down, minimap. (Mainnet block-countdown math TODO; regtest shows RDTS
  deployment status instead.)
- **Phase 5 — Fork view + theming — ✅ DONE:** two-lane split at the LCA, red invalid-block styling,
  `FORK AT #h` junction, Core-circuit (B&W, left) / Knots-Celtic (green, right) two-sided theme with the
  agreed-state seam. Demoed via `e2e/demo.sh` + `e2e/trigger_fork.sh`.
- **Phase 6 — Productionize mainnet — ✅ (running):** `compose/docker-compose.mainnet.yml` — `tor` +
  two pruned, blocks-only nodes syncing the real chain over **Tor (P2P only; RPC/ZMQ stay internal)**,
  bootstrapped via a one-time `loadtxoutset` of `utxo-840000.dat` (entrypoint waits for headers ≥ 840k,
  then loads). Backend reworked: **SQLite persistence** (`db.rs`), **prune-aware incremental ingest +
  backfill from tip → backwards**, **hard stop at the node prune height** (code + UI), and a `syncing`
  state distinct from a real fork (Knots behind ≠ fork). Same app image, `NETWORK=mainnet`, on `:8081`.
  DB-clear tooling: `scripts/clear-db.sh {regtest|mainnet}`. Verified serving real blocks with real
  `would_violate` verdicts while nodes sync.
- **Phase 7 — Isometric UI overhaul + backend perf — ✅ (iterating):** the card/list frontend was
  rebuilt as the **isometric chain visualizer** (§5.7) through many rounds of live feedback (fisheye
  tuning, chain-link geometry, detent snapping, focus pop/lift, lane separation, top-face anchoring).
  Backend performance + focus work landed alongside:
  - **rust-bitcoin raw-block parsing** — `getblock <hash> 0` + `consensus::deserialize` replaced the
    heavy `verbosity=2` JSON; one decode yields all metadata + the tx set for the RDTS scan.
  - **Aggregated violations** — `Violation { rule, kind, count }` per block (was per-txid); smaller
    `/api/state`, cleaner drill-down.
  - **Off-critical-path startup** — the SQLite warm-up (deserialize every stored block) moved to the
    ingest thread, so the HTTP server responds in ~0 s instead of blocking ~10–20 s on a warm cache.
  - **Configurable mainnet floor** — `FLOOR_HEIGHT=927360` (first 2016-epoch where bit-4 signaling was
    possible) floors the visualization to the relevant window. It only *engages once the node syncs
    past it* (until then it shows available history rather than flooring above the tip), then the view
    snaps to `927360 → tip` automatically.

**Still deferred:** further UI polish, RDTS input-side rules 3–7 (need prevouts — revisit once chains
sync past activation), mainnet activation-countdown math (blocks/ETA to 961,632 & 965,664), Scenario B
(reconverge) + C (signaling) e2e scripts, and node↔node peering on mainnet (skipped: `onlynet=onion`
blocks internal clearnet peering; both nodes get blocks independently from the network, so a real fork
is still detected via each node's `getchaintips`).

---

## 11. Decisions locked & remaining questions

**Locked (from user):**
- Peer the two nodes (`PEER_NODES=true`).
- Serve the React bundle from the Rust backend (single container).
- Scrollback goes as far back as the nodes retain blocks (= prune window), with dynamic infinite
  scroll; prune sized for ≥1 year (§3.1) → back past BIP-110 authoring and a full year (~block 905k).
- Two-sided theme: Core = circuit-board / clean B&W (left); Knots = Celtic knotwork / green (right).
  *(Superseded in Phase 7 — the isometric UI uses a cleaner Core-mono/graphite vs Knots-emerald palette;
  the circuit/Celtic motifs and the "seam that tears" were dropped.)*
- Per-block badges: (A) BIP-110 bit-4 signaling, (B) RDTS content verdict pass / would-violate / invalid.
- **Show would-violate on every block now** (pre-enforcement) as a "will be invalid soon" indicator —
  creation-side rules authoritative, input-side hits shown as advisory (exemption caveat).
- **Top countdown banner** to mandatory-signaling (961,632) and activation (965,664) in blocks *and*
  best-estimate time; **signaling minimap** side helper with per-epoch (2016) signaled-vs-not totals
  and the 55% (1109/2016) threshold marker.

- **Versions pinned:** Core **v31.1**, Knots **v29.3.knots20260508**. Snapshot **settled at height
  840,000** (`utxo-840000.dat`, in place & verified) — accepted by both.
- **Regtest-first:** build/test on regtest with a dedicated `e2e/` harness that forces the fork on
  demand (§10a), then a separate `docker-compose.mainnet.yml` production config; same app code both.

**Resolved during Phase 0 (empirically, on the real binaries):**
1. **Enable RDTS on Knots headless:** `consensusrules=rdts` in `bitcoin.conf` (the config equivalent of
   the GUI confirm prompt). Accepted with no warning. ✅
2. **Activate RDTS on regtest:** the deployment is `DEPLOYMENT_REDUCED_DATA` (vbparams name
   **`reduced_data`**, **bit 4**); regtest chainparams hardcode it **`NEVER_ACTIVE`**. Override on the
   **Knots node only** with `vbparams=reduced_data:0:9223372036854775807`, then mine bit-4-signaling
   blocks on Knots — it walks the normal BIP9 path on the regtest 144-block window: STARTED ~144,
   LOCKED_IN ~288, **ACTIVE ~432**. Core rejects `vbparams=reduced_data` (no such deployment) — correct,
   it stays the non-enforcing side with no special flag. ✅ (Note the vbparams name is `reduced_data`,
   **not** `rdts` — the latter crash-loops the node with "Invalid deployment".)
3. ~~Input-side rule detail~~ — **resolved:** show would-violate on all blocks now; creation-side rules
   authoritative, input-side advisory (pre-activation-UTXO exemption); tighten precision near activation.

**Phase 0 fork mechanics: PROVEN.** A post-activation 200-byte-`OP_RETURN` block (rule 1) mined on Core
is accepted by Core and marked **`invalid`** by Knots (`getchaintips`), Knots tip stays one behind —
a real fork, reproduced green end-to-end by `e2e/run.sh`. This is the exact `status:"invalid"` branch
signal the app renders.

---

## 12. Sources

- BIP-110 overview: https://bip110.org/ · https://bips.dev/110/ · https://github.com/bitcoin/bips/blob/master/bip-0110.mediawiki
- Layman's guide: https://blog.lopp.net/a-laymans-guide-to-bip-110/
- Knots RDTS release: https://github.com/bitcoinknots/bitcoin/releases/tag/v29.3.knots20260508
- Core v31.0 release: https://bitcoincore.org/en/releases/31.0/ (v31.1 latest, 2026-07-08)
- assumeutxo docs: https://github.com/bitcoin/bitcoin/blob/master/doc/assumeutxo.md · https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/loadtxoutset/
- assumeutxo 910k param (Core 30): https://github.com/bitcoin/bitcoin/pull/33274 · 880k: https://github.com/bitcoin/bitcoin/pull/31969
