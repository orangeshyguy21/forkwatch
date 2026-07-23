use crate::db;
use crate::model::{AppState, Block, NodeInfo};
use crate::rdts;
use crate::rpc::Rpc;
use parking_lot::RwLock;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tracing::{debug, error, info, warn};

/// Max new blocks pulled from a tip per poll. Deliberately small: catch-up after downtime is the job
/// of the backfill pass below (BACKFILL_BATCH per poll), and a large tip walk would monopolize the
/// ingest loop for one poll while contributing nothing the backfill would not.
const TIP_MAX: usize = 25;
const BACKFILL_BATCH: usize = 200; // older blocks pulled toward the prune floor per poll
const MINER_BACKFILL_BATCH: usize = 40; // retained blocks re-scanned for coinbase/miner data per poll
/// Hard ceiling on `getrawtransaction` lookups per block during prevout resolution. A mainnet block
/// has thousands of distinct inputs; resolving them serially inside a poll window wedges ingest
/// outright. Rule 3 coverage is best-effort by design, so truncating is the correct failure mode.
const PREVOUT_MAX_LOOKUPS: usize = 200;
/// Newest blocks carried in each WebSocket push frame. Enough to cover a short client gap or a
/// shallow reorg without a refetch; small enough that the frame stays a few KB.
const PUSH_BLOCKS: i64 = 8;

pub struct Nodes {
    pub core: Rpc,
    pub knots: Rpc,
    pub scheduled_fork_height: Option<i64>,
    /// What the countdown is counting down TO, for the header to name. The event differs by network:
    /// on mainnet it is BIP-110 mandatory signaling; on regtest it is the demo miner's staged fork.
    pub scheduled_fork_label: Option<String>,
    /// Protocol target block interval in seconds (mainnet 600). Set only where difficulty
    /// retargeting actually binds — leaving it unset (regtest) makes the ETA trust measurement
    /// alone, which is correct there because regtest difficulty never constrains the miner.
    pub target_spacing_secs: Option<i64>,
    /// Blocks per difficulty epoch (mainnet 2016).
    pub retarget_interval: i64,
    /// Hard floor for the visualization: never ingest/serve below this height (0 = node prune floor).
    /// Focuses the app on a relevant window (e.g. the first epoch RDTS signaling was possible).
    pub floor_height: i64,
    /// Whether to resolve spent-output scriptPubKeys for RDTS rule 3. `None` = decide by network,
    /// which enables it on regtest only. This must NOT be inferred from RDTS being active: activation
    /// on mainnet would otherwise turn every block into thousands of serial `getrawtransaction`
    /// calls that all fail under `txindex=0` — at exactly the moment the app matters most.
    /// Set `RESOLVE_PREVOUTS=1` only alongside `txindex=1`.
    pub resolve_prevouts: Option<bool>,
}

pub fn spawn(
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<Arc<str>>,
    nodes: Nodes,
    poll_ms: u64,
    conn: Option<Connection>,
) {
    thread::spawn(move || {
        // Warm the in-memory index from SQLite here (not in main) so the HTTP server serves
        // immediately; the UI shows a loading state until this finishes. The slow part —
        // deserializing every stored block — runs WITHOUT the lock; only the insert loop holds it.
        if let Some(c) = conn.as_ref() {
            match db::load_all(c) {
                Ok(blocks) => {
                    let n = blocks.len();
                    let mut g = state.write();
                    for b in blocks {
                        g.by_hash.insert(b.hash.clone(), b);
                    }
                    drop(g);
                    info!(blocks = n, "warmed in-memory index from db");
                }
                Err(e) => error!(error = format!("{e:#}"), "db load_all failed"),
            }
        }
        loop {
            let started = Instant::now();
            match poll_once(&state, &nodes, conn.as_ref()) {
                Ok(frame) => {
                    state.write().last_poll_ok = Some(Instant::now());
                    if let Some(frame) = frame {
                        let _ = tx.send(frame);
                    }
                    debug!(elapsed_ms = started.elapsed().as_millis() as u64, "poll complete");
                }
                Err(e) => error!(error = format!("{e:#}"), "poll failed"),
            }
            thread::sleep(Duration::from_millis(poll_ms));
        }
    });
}

/// One ingest pass. Returns the WebSocket push frame when anything observable changed, so the caller
/// broadcasts exactly the bytes clients need — no fan-out of HTTP refetches (§5.1).
fn poll_once(
    state: &Arc<RwLock<AppState>>,
    nodes: &Nodes,
    conn: Option<&Connection>,
) -> anyhow::Result<Option<Arc<str>>> {
    let core_info = node_info(&nodes.core, "Bitcoin Core").unwrap_or_else(|e| {
        warn!(node = "core", error = format!("{e:#}"), "node unreachable");
        NodeInfo { label: "Bitcoin Core".into(), online: false, ..Default::default() }
    });
    let knots_info = node_info(&nodes.knots, "Bitcoin Knots").unwrap_or_else(|e| {
        warn!(node = "knots", error = format!("{e:#}"), "node unreachable");
        NodeInfo { label: "Bitcoin Knots".into(), online: false, ..Default::default() }
    });

    let knots_dep = nodes.knots.call("getdeploymentinfo", json!([])).ok();
    let (rdts_status, rdts_since, rdts_bit) = parse_rdts(&knots_dep);
    let signaling_stats = parse_signaling(&knots_dep);
    let activation = if rdts_status == "active" { rdts_since } else { None };

    let core_tips = chaintip_status_map(&nodes.core).unwrap_or_default();
    let knots_tips = chaintip_status_map(&nodes.knots).unwrap_or_default();
    // BACKFILL target: how far down we FETCH from the node. We can't pull blocks the node has pruned,
    // so this is bounded by the node's own prune height (raised to the configured floor once synced
    // past it). Distinct from the SERVE floor below, which is cache-driven — once a block is cached we
    // keep serving it even after the node prunes it away. This decoupling is what lets a temporary
    // non-pruned re-sync permanently populate the historical window.
    let base_floor = core_info.prune_height.max(0);
    let backfill_target = if nodes.floor_height > 0 && core_info.blocks >= nodes.floor_height {
        nodes.floor_height.max(base_floor)
    } else {
        base_floor
    };

    // Rule 3 needs one `getrawtransaction` per distinct input, which only resolves under txindex=1.
    // Decided by NETWORK, never by whether RDTS happens to be active — see `Nodes::resolve_prevouts`.
    let prevouts_ok = nodes.resolve_prevouts.unwrap_or(core_info.chain == "regtest");

    // 1. Tip sync (short; usually 0-1 new blocks). Every RPC here happens with NO lock held — the
    //    lock is taken per block, only long enough to test membership or insert. Holding it across
    //    the fetch would stall every reader for the length of a catch-up walk.
    let mut changed = {
        let a = fetch_tip_down(&nodes.core, &core_info.bestblockhash, core_info.blocks, state, conn, backfill_target, activation, prevouts_ok, TIP_MAX);
        let b = fetch_tip_down(&nodes.knots, &knots_info.bestblockhash, knots_info.blocks, state, conn, backfill_target, activation, prevouts_ok, TIP_MAX);
        a > 0 || b > 0
    };

    // 1b. Miner backfill for the node's still-retained near-tip window. Blocks cached before this
    // feature existed (and freshly warmed history within the node's retained range) carry no
    // coinbase-derived miner data — coinbase_tag is NULL. Re-derive it for a bounded batch of the
    // newest such blocks each poll; over a few polls the retained window fills in. Blocks below the
    // node's prune height are gone and can't be re-fetched, so they're never candidates.
    {
        let retain_floor = core_info.prune_height.max(0);
        let candidates: Vec<(String, i64)> = {
            let g = state.read();
            let core_map = build_height_map(&g.by_hash, &core_info.bestblockhash);
            let mut v: Vec<(String, i64)> = core_map
                .iter()
                .filter(|(h, _)| **h >= retain_floor)
                .filter_map(|(h, hash)| g.by_hash.get(hash).filter(|b| b.coinbase_tag.is_none()).map(|_| (hash.clone(), *h)))
                .collect();
            v.sort_by(|a, b| b.1.cmp(&a.1)); // newest first — most likely to be viewed
            v.truncate(MINER_BACKFILL_BATCH);
            v
        };
        if !candidates.is_empty() {
            let refreshed: Vec<Block> = candidates
                .into_iter()
                .filter_map(|(hash, h)| fetch_one(&nodes.core, &hash, h, activation, prevouts_ok))
                .collect();
            if !refreshed.is_empty() {
                let mut g = state.write();
                for b in refreshed {
                    if let Some(c) = conn {
                        let _ = db::upsert(c, &b);
                    }
                    g.by_hash.insert(b.hash.clone(), b);
                }
                changed = true;
            }
        }
    }

    // 2. Backfill history downward toward the prune floor. Fetch lock-free, insert under lock.
    let start = {
        let g = state.read();
        let core_map = build_height_map(&g.by_hash, &core_info.bestblockhash);
        core_map.keys().min().copied().and_then(|low| {
            if low > backfill_target {
                core_map
                    .get(&low)
                    .and_then(|h| g.by_hash.get(h))
                    .map(|b| (b.prev_hash.clone(), low - 1))
            } else {
                None
            }
        })
    };
    if let Some((parent, ph)) = start {
        let fetched = fetch_batch(&nodes.core, &parent, ph, backfill_target, activation, prevouts_ok, BACKFILL_BATCH);
        if !fetched.is_empty() {
            let mut g = state.write();
            for b in fetched {
                if let Some(c) = conn {
                    let _ = db::upsert(c, &b);
                }
                g.by_hash.entry(b.hash.clone()).or_insert(b);
            }
            changed = true;
        }
    }

    // 2b. Knots minority-chain backfill: walk the Knots chain down toward where it rejoins Core's
    // chain (a shared, already-known block) or the prune floor. This makes the FULL Knots branch
    // available (not just the near-tip cap) for /api/blocks/range?chain=knots — so each node's
    // perspective of the fork can be visualized end to end.
    {
        // Resolve the walk's starting point under a read guard, then release it: the fetch loop below
        // acquires the lock per block rather than holding it across RPC (same reason as step 1).
        let start = {
            let g = state.read();
            let knots_map = build_height_map(&g.by_hash, &knots_info.bestblockhash);
            knots_map.keys().min().copied().and_then(|low| {
                if low > backfill_target {
                    knots_map
                        .get(&low)
                        .and_then(|hash| g.by_hash.get(hash))
                        .map(|b| (b.prev_hash.clone(), low - 1))
                } else {
                    None
                }
            })
        };
        if let Some((parent, ph)) = start {
            let n = fetch_tip_down(
                &nodes.knots, &parent, ph, state, conn, backfill_target, activation, prevouts_ok, BACKFILL_BATCH,
            );
            if n > 0 {
                changed = true;
            }
        }
    }

    // 3. Rebuild chain maps + state snapshot. The heavy work — two full-chain map walks, the epoch
    //    scan, fork-branch assembly, and serializing both the state body and the push frame — is done
    //    under a *shared read* guard, so concurrent API readers keep serving throughout (the ingest
    //    thread is the only writer, so nothing contends the read). Only the final pointer swap takes
    //    the exclusive write lock, and it is a handful of moves. This is what keeps p99 from spiking
    //    every poll: the old code held the *write* lock across all of this, and parking_lot's
    //    writer-fair queuing parked every reader behind it for the whole rebuild.
    let (
        core_map, knots_map, core_tips_out, knots_tips_out, core_tip_h, knots_tip_h, serve_floor,
        lca_h, sj, sj_str, frame, node_changed,
    ) = {
        let g = state.read();
        let core_map = build_height_map(&g.by_hash, &core_info.bestblockhash);
        let knots_map = build_height_map(&g.by_hash, &knots_info.bestblockhash);
        let core_tip_h = core_map.keys().max().copied().unwrap_or(-1);
        let knots_tip_h = knots_map.keys().max().copied().unwrap_or(-1);

        // SERVE floor: cache-driven. We serve every height we've cached down to the lowest contiguous
        // block reaching the tip — independent of the node's current prune height, so blocks captured
        // during a temporary non-pruned window stay servable after the node re-prunes them. Held at
        // the configured display floor when one is set.
        let min_cached = core_map.keys().min().copied().unwrap_or(backfill_target);
        let serve_floor = if nodes.floor_height > 0 { min_cached.max(nodes.floor_height) } else { min_cached };

        let node_changed = core_info.bestblockhash != g.core.bestblockhash
            || knots_info.bestblockhash != g.knots.bestblockhash
            || core_info.blocks != g.core.blocks
            || core_info.online != g.core.online
            || knots_info.online != g.knots.online;

        let mut sj = build_state_json(
            &g.by_hash, &core_map, &knots_map, &core_info, &knots_info, &core_tips, &knots_tips,
            &rdts_status, rdts_since, rdts_bit, nodes.scheduled_fork_height,
            nodes.scheduled_fork_label.as_deref(), nodes.target_spacing_secs,
            nodes.retarget_interval, core_tip_h, knots_tip_h,
            serve_floor, signaling_stats,
        );
        // The CONFIGURED display floor (0 = none). The rail spans [floor_height, tip] to draw the full
        // epoch structure even when the node has only pruned-retained a thin near-tip window; the app
        // shades [floor_height, prune_floor) as not-yet-cached. Distinct from prune_floor (data floor).
        if let Some(o) = sj.as_object_mut() {
            o.insert("floor_height".to_string(), json!(nodes.floor_height));
        }
        // Highest common block, read back from the state we just built — this is the finality horizon
        // `/api/blocks/range` needs to know a below-tip window can never change again.
        let lca_h = sj.get("lca_height").and_then(|v| v.as_i64()).unwrap_or(-1);

        // The push frame: everything a client used to fetch in three requests per block. Built once
        // per poll and shared by every socket, so a new block costs O(clients) bytes and 0 requests.
        let push_blocks: Vec<Value> = ((core_tip_h - PUSH_BLOCKS + 1).max(serve_floor)..=core_tip_h)
            .rev()
            .filter_map(|h| core_map.get(&h).and_then(|hash| g.by_hash.get(hash)))
            .map(|b| block_json(b, &core_map, &knots_map, &core_tips, &knots_tips))
            .collect();
        let frame: Arc<str> = Arc::from(
            json!({ "type": "update", "state": &sj, "blocks": push_blocks }).to_string().as_str(),
        );
        // Pre-serialize the /api/state body once here (not per request) so the handler serves a shared
        // Arc instead of deep-cloning and reserializing the Value under the read lock on every hit.
        let sj_str: Arc<str> = Arc::from(sj.to_string().as_str());

        (
            core_map, knots_map, core_tips, knots_tips, core_tip_h, knots_tip_h, serve_floor,
            lca_h, sj, sj_str, frame, node_changed,
        )
    };
    changed = changed || node_changed;

    {
        let mut g = state.write();
        g.core_by_height = core_map;
        g.knots_by_height = knots_map;
        g.core_tips_status = core_tips_out;
        g.knots_tips_status = knots_tips_out;
        g.core_tip_h = core_tip_h;
        g.knots_tip_h = knots_tip_h;
        g.lca_height = lca_h;
        g.prune_floor = serve_floor;
        g.core = core_info;
        g.knots = knots_info;
        g.state_json = sj;
        g.state_json_str = Some(sj_str);
        g.push_frame = Some(frame.clone());
    }

    Ok(if changed { Some(frame) } else { None })
}

fn node_info(rpc: &Rpc, label: &str) -> anyhow::Result<NodeInfo> {
    let bci = rpc.call("getblockchaininfo", json!([]))?;
    let ni = rpc.call("getnetworkinfo", json!([])).unwrap_or(Value::Null);
    let conns = rpc.call("getconnectioncount", json!([])).ok().and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(NodeInfo {
        label: label.to_string(),
        chain: bci.get("chain").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        version: ni.get("subversion").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        blocks: bci.get("blocks").and_then(|v| v.as_i64()).unwrap_or(0),
        headers: bci.get("headers").and_then(|v| v.as_i64()).unwrap_or(0),
        bestblockhash: bci.get("bestblockhash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        connections: conns,
        online: true,
        pruned: bci.get("pruned").and_then(|v| v.as_bool()).unwrap_or(false),
        prune_height: bci.get("pruneheight").and_then(|v| v.as_i64()).unwrap_or(0),
        verification_progress: bci.get("verificationprogress").and_then(|v| v.as_f64()).unwrap_or(0.0),
        ibd: bci.get("initialblockdownload").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

fn chaintip_status_map(rpc: &Rpc) -> anyhow::Result<HashMap<String, String>> {
    let tips = rpc.call("getchaintips", json!([]))?;
    let mut m = HashMap::new();
    if let Some(arr) = tips.as_array() {
        for t in arr {
            if let (Some(h), Some(s)) = (
                t.get("hash").and_then(|v| v.as_str()),
                t.get("status").and_then(|v| v.as_str()),
            ) {
                m.insert(h.to_string(), s.to_string());
            }
        }
    }
    Ok(m)
}

fn is_zero_hash(h: &str) -> bool {
    h.is_empty() || h.chars().all(|c| c == '0')
}

/// Walk from a tip toward the prune floor, fetching+persisting blocks not yet known. Height is
/// tracked from `tip_height` and decremented per step (a serialized block doesn't carry its height).
/// Stops at a known block, the prune floor, an RPC error (pruned/unavailable), or after `max`.
///
/// The lock is acquired per block — once to test membership, once to insert — and is **never held
/// across the RPC**. A tip walk can take arbitrarily long (a node restart, a deep reorg, a slow
/// peer); holding the write guard for its duration would stop every reader, i.e. take the API down
/// under precisely the conditions where the dashboard matters most.
#[allow(clippy::too_many_arguments)]
fn fetch_tip_down(
    rpc: &Rpc,
    tip: &str,
    tip_height: i64,
    state: &RwLock<AppState>,
    conn: Option<&Connection>,
    floor: i64,
    activation: Option<i64>,
    resolve_prevouts: bool,
    max: usize,
) -> usize {
    if is_zero_hash(tip) {
        return 0;
    }
    let mut cur = tip.to_string();
    let mut height = tip_height;
    let mut n = 0;
    while n < max && height >= floor && !is_zero_hash(&cur) {
        if state.read().by_hash.contains_key(&cur) {
            break;
        }
        let Some(block) = fetch_one(rpc, &cur, height, activation, resolve_prevouts) else { break };
        let prev = block.prev_hash.clone();
        if let Some(c) = conn {
            let _ = db::upsert(c, &block);
        }
        state.write().by_hash.insert(block.hash.clone(), block);
        n += 1;
        height -= 1;
        cur = prev;
    }
    n
}

/// Lock-free walk of up to `max` blocks down from `start_hash` (`start_height`) toward the prune floor.
#[allow(clippy::too_many_arguments)]
fn fetch_batch(
    rpc: &Rpc,
    start_hash: &str,
    start_height: i64,
    floor: i64,
    activation: Option<i64>,
    resolve_prevouts: bool,
    max: usize,
) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur = start_hash.to_string();
    let mut height = start_height;
    while out.len() < max && height >= floor && !is_zero_hash(&cur) {
        let Some(block) = fetch_one(rpc, &cur, height, activation, resolve_prevouts) else { break };
        let prev = block.prev_hash.clone();
        out.push(block);
        height -= 1;
        cur = prev;
    }
    out
}

/// Fetch one RAW block (`getblock <hash> 0`) and parse it with rust-bitcoin — far faster than the
/// verbosity-2 JSON (smaller transfer, native script scan). `height` is supplied by the caller since
/// a serialized block carries no height.
fn fetch_one(
    rpc: &Rpc,
    hash: &str,
    height: i64,
    activation: Option<i64>,
    resolve: bool,
) -> Option<Block> {
    let raw = rpc.call("getblock", json!([hash, 0])).ok()?;
    let hexs = raw.as_str()?;
    let bytes = hex::decode(hexs).ok()?;
    let b: bitcoin::Block = bitcoin::consensus::deserialize(&bytes).ok()?;
    let version = b.header.version.to_consensus() as i64;
    let signals_110 = (version & 0x2000_0000) != 0 && (version & (1 << 4)) != 0;
    // Rule 3 needs the spent outputs' scriptPubKeys. Gated on `resolve` (network/config), not merely
    // on post-activation height: on a txindex=0 node every lookup fails, so an unguarded pass would
    // spend thousands of doomed round-trips per block.
    let prevouts = if resolve && activation.map(|a| height >= a).unwrap_or(false) {
        resolve_prevouts(rpc, &b)
    } else {
        HashMap::new()
    };
    let v = rdts::check_block(&b, height, activation, &prevouts);
    let m = crate::miner::identify(&b);
    Some(Block {
        height,
        hash: b.block_hash().to_string(),
        prev_hash: b.header.prev_blockhash.to_string(),
        time: b.header.time as i64,
        size: bytes.len() as i64,
        weight: b.weight().to_wu() as i64,
        tx_count: b.txdata.len() as i64,
        version,
        signals_110,
        rdts_verdict: v.verdict,
        rdts_rule_hits: v.rules,
        violations: v.violations,
        miner: m.name,
        coinbase_tag: m.tag,
    })
}

/// Resolve the scriptPubKey of every non-coinbase input's spent output, for rule 3 (undefined witness
/// version). Uses `getrawtransaction <txid> true`, which requires `txindex=1`; best-effort, any input
/// that can't be resolved is simply skipped.
///
/// Bounded by `PREVOUT_MAX_LOOKUPS` regardless of caller. These calls are serial and synchronous
/// inside the poll window, so an unbounded loop over a full block's inputs is an ingest stall, not a
/// slow path. Truncation degrades rule-3 coverage for that block — the correct trade against a
/// wedged loop, and the reason the caller also gates this on network.
fn resolve_prevouts(rpc: &Rpc, block: &bitcoin::Block) -> HashMap<bitcoin::OutPoint, bitcoin::ScriptBuf> {
    let mut map = HashMap::new();
    let mut lookups = 0usize;
    for tx in &block.txdata {
        if tx.is_coinbase() {
            continue;
        }
        for txin in &tx.input {
            let op = txin.previous_output;
            if map.contains_key(&op) {
                continue;
            }
            if lookups >= PREVOUT_MAX_LOOKUPS {
                warn!(
                    block = %block.block_hash(),
                    limit = PREVOUT_MAX_LOOKUPS,
                    "prevout resolution truncated; rule 3 coverage is partial for this block"
                );
                return map;
            }
            lookups += 1;
            let Ok(res) = rpc.call("getrawtransaction", json!([op.txid.to_string(), true])) else {
                continue;
            };
            let Some(spk_hex) = res
                .get("vout")
                .and_then(|v| v.get(op.vout as usize))
                .and_then(|o| o.get("scriptPubKey"))
                .and_then(|s| s.get("hex"))
                .and_then(|h| h.as_str())
            else {
                continue;
            };
            if let Ok(bytes) = hex::decode(spk_hex) {
                map.insert(op, bitcoin::ScriptBuf::from_bytes(bytes));
            }
        }
    }
    map
}

/// Build height -> hash for the contiguous active chain ending at `tip` (down to the lowest known block).
fn build_height_map(by_hash: &HashMap<String, Block>, tip: &str) -> HashMap<i64, String> {
    let mut m = HashMap::new();
    let mut cur = tip.to_string();
    while let Some(b) = by_hash.get(&cur) {
        m.insert(b.height, b.hash.clone());
        if is_zero_hash(&b.prev_hash) {
            break;
        }
        cur = b.prev_hash.clone();
    }
    m
}

fn status_of(height: i64, hash: &str, by_height: &HashMap<i64, String>, tips: &HashMap<String, String>) -> String {
    if by_height.get(&height).map(|s| s == hash).unwrap_or(false) {
        return "active".to_string();
    }
    if let Some(s) = tips.get(hash) {
        return s.clone();
    }
    "absent".to_string()
}

pub fn block_json(
    b: &Block,
    cbh: &HashMap<i64, String>,
    kbh: &HashMap<i64, String>,
    ct: &HashMap<String, String>,
    kt: &HashMap<String, String>,
) -> Value {
    json!({
        "height": b.height,
        "hash": b.hash,
        "prev_hash": b.prev_hash,
        "time": b.time,
        "size": b.size,
        "weight": b.weight,
        "tx_count": b.tx_count,
        "version": b.version,
        "signals_110": b.signals_110,
        "rdts_verdict": b.rdts_verdict,
        "rdts_rule_hits": b.rdts_rule_hits,
        "miner": b.miner,
        "coinbase_tag": b.coinbase_tag,
        "core_status": status_of(b.height, &b.hash, cbh, ct),
        "knots_status": status_of(b.height, &b.hash, kbh, kt),
    })
}

#[allow(clippy::too_many_arguments)]
fn build_state_json(
    by_hash: &HashMap<String, Block>,
    core_map: &HashMap<i64, String>,
    knots_map: &HashMap<i64, String>,
    core: &NodeInfo,
    knots: &NodeInfo,
    core_tips: &HashMap<String, String>,
    knots_tips: &HashMap<String, String>,
    rdts_status: &str,
    rdts_since: Option<i64>,
    rdts_bit: i64,
    scheduled_fork_height: Option<i64>,
    scheduled_fork_label: Option<&str>,
    target_spacing_secs: Option<i64>,
    retarget_interval: i64,
    core_tip_h: i64,
    knots_tip_h: i64,
    prune_floor: i64,
    signaling_stats: Option<(i64, i64, i64, f64)>,
) -> Value {
    let tip_height = core_tip_h.max(knots_tip_h);
    let agreed = !core.bestblockhash.is_empty() && core.bestblockhash == knots.bestblockhash;

    let mut lca = -1i64;
    let mut h = core_tip_h.min(knots_tip_h);
    while h >= 0 {
        if let (Some(a), Some(b)) = (core_map.get(&h), knots_map.get(&h)) {
            if a == b {
                lca = h;
                break;
            }
        }
        h -= 1;
    }

    // Three distinct ways the nodes can disagree. Only the first is a chain SPLIT.
    //
    //   split    — both nodes hold a block at the same height with different hashes. Since `lca` is
    //              the highest common block, both tips sitting above it means exactly that. This is
    //              the definition: two competing blocks, not one node being ahead.
    //   rejected — Knots marks Core's tip invalid but has not yet produced a competing block of its
    //              own. The chains are already irreconcilable, but there is no rival block at the
    //              same height *yet*, so it is not a split. Calling this "syncing" would be wrong.
    //   syncing  — plain lag: one node is simply behind on the same chain. NOT a split.
    // Knots reports Core's *tip* as invalid only in the instant before Core mines past it: a node
    // never requests the descendants of a block it rejected, so once Core extends its branch its
    // tip is simply ABSENT from Knots' chaintips — not invalid. Reading only the tip therefore
    // downgrades a live fork to "syncing" one block after it happens. The durable signal is the
    // rejected block itself: Core's first block above the last common one, which is precisely what
    // Knots refused and keeps listed as an invalid tip.
    let knots_rejects_core = knots_tips.get(&core.bestblockhash).map(|s| s == "invalid").unwrap_or(false)
        || (lca >= 0
            && core_map
                .get(&(lca + 1))
                .and_then(|h| knots_tips.get(h))
                .map(|s| s == "invalid")
                .unwrap_or(false));
    let have_both = !core.bestblockhash.is_empty() && !knots.bestblockhash.is_empty();
    let split = have_both && lca >= 0 && lca < core_tip_h && lca < knots_tip_h;
    let rejected = have_both && !agreed && !split && knots_rejects_core;
    let syncing = have_both && !agreed && !split && !rejected;
    // The fork *payload* (branch blocks, Knots' view of Core's tip) is what the chain view renders,
    // and it is meaningful as soon as the chains are irreconcilable — split or merely rejected.
    let real_fork = split || rejected;

    // Cap branches shipped in /api/state to a near-tip window (the fisheye only shows a few dozen).
    // Deep forks (e.g. a long-running regtest demo) would otherwise bloat every poll. Full depth is
    // reported via *_branch_len so the UI can label it accurately.
    const BRANCH_CAP: usize = 250;
    let fork = if !real_fork {
        Value::Null
    } else {
        let core_branch: Vec<Value> = ((lca + 1)..=core_tip_h)
            .rev()
            .take(BRANCH_CAP)
            .filter_map(|hh| core_map.get(&hh).and_then(|h| by_hash.get(h)))
            .map(|b| block_json(b, core_map, knots_map, core_tips, knots_tips))
            .collect();
        let knots_branch: Vec<Value> = ((lca + 1)..=knots_tip_h)
            .rev()
            .take(BRANCH_CAP)
            .filter_map(|hh| knots_map.get(&hh).and_then(|h| by_hash.get(h)))
            .map(|b| block_json(b, core_map, knots_map, core_tips, knots_tips))
            .collect();
        let kv = knots_tips.get(&core.bestblockhash).cloned().unwrap_or_else(|| "absent".into());
        json!({
            "at_height": lca,
            "core_branch": core_branch,
            "knots_branch": knots_branch,
            "core_branch_len": (core_tip_h - lca).max(0),
            "knots_branch_len": (knots_tip_h - lca).max(0),
            "knots_view_of_core_tip": kv,
        })
    };

    // Signaling gauge for the CURRENT retarget period — NOT a trailing rolling window, which would
    // drag in signals from the tail of the previous epoch and overcount. Prefer the node's own BIP9
    // accounting (getdeploymentinfo statistics): period-aligned, network-correct (2016 mainnet / 144
    // regtest), and identical to what `bitcoin-cli` reports. Fall back to an epoch-aligned local count
    // over Core's chain when the node exposes no statistics (deployment not in the "started" phase).
    let (window, signaled, total, threshold_pct) = match signaling_stats {
        Some((sig, elapsed, period, thr)) => (period, sig, elapsed, thr),
        None => {
            let period = 2016i64;
            let start = core_tip_h - core_tip_h.rem_euclid(period);
            let (mut signaled, mut total) = (0i64, 0i64);
            for hh in start..=core_tip_h {
                if let Some(hash) = core_map.get(&hh) {
                    if let Some(b) = by_hash.get(hash) {
                        total += 1;
                        if b.signals_110 {
                            signaled += 1;
                        }
                    }
                }
            }
            (period, signaled, total, 55.0)
        }
    };
    let pct = if total > 0 { signaled as f64 * 100.0 / total as f64 } else { 0.0 };

    json!({
        "core": core,
        "knots": knots,
        "agreed": agreed,
        "syncing": syncing,
        "split": split,
        "rejected": rejected,
        "lca_height": if lca >= 0 { Value::from(lca) } else { Value::Null },
        "tip_height": tip_height,
        "prune_floor": prune_floor,
        "fork": fork,
        "rdts": { "status": rdts_status, "since_height": rdts_since, "bit": rdts_bit },
        "signaling": {
            "window": window, "signaled": signaled, "total": total,
            "pct": pct, "threshold_pct": threshold_pct
        },
        // Countdown target. `reached` is keyed on an actual SPLIT, not on mere disagreement: the two
        // nodes fall out of sync for a moment on nearly every mainnet block as one hears it first,
        // and that must not retire the clock.
        "scheduled_fork": scheduled_fork_height.map(|fh| json!({
            "height": fh,
            "label": scheduled_fork_label,
            "blocks_until": (fh - core_tip_h).max(0),
            "reached": split || core_tip_h >= fh,
        })).unwrap_or(Value::Null),
        // Difficulty geometry, so the ETA can stop extrapolating the *current* block rate past the
        // point where it stops applying. A block's difficulty comes from its epoch, and the epoch
        // turns over at heights divisible by `retarget_interval`; beyond that boundary the protocol
        // pulls the interval back toward `target_spacing`, which is a far better predictor than any
        // measurement of recent blocks. Null target_spacing = retargeting does not bind (regtest).
        "pacing": {
            "target_spacing": target_spacing_secs,
            "retarget_interval": retarget_interval,
            "next_retarget_height": if retarget_interval > 0 {
                Value::from((core_tip_h / retarget_interval + 1) * retarget_interval)
            } else {
                Value::Null
            },
        },
    })
}

fn parse_rdts(dep: &Option<Value>) -> (String, Option<i64>, i64) {
    let Some(dep) = dep else { return ("never".into(), None, 4) };
    let Some(rd) = dep.get("deployments").and_then(|d| d.get("reduced_data")) else {
        return ("never".into(), None, 4);
    };
    let bip9 = rd.get("bip9");
    let status = bip9.and_then(|b| b.get("status")).and_then(|s| s.as_str()).unwrap_or("never").to_string();
    let since = if rd.get("active").and_then(|a| a.as_bool()).unwrap_or(false) {
        rd.get("height").and_then(|h| h.as_i64())
    } else {
        None
    };
    let bit = bip9.and_then(|b| b.get("bit")).and_then(|b| b.as_i64()).unwrap_or(4);
    (status, since, bit)
}

/// The node's own BIP9 signaling tally for the CURRENT retarget period, from `getdeploymentinfo`.
/// Returns (signaled, elapsed, period, threshold_pct). This is period-aligned and network-correct
/// (2016 on mainnet, 144 on regtest) — the same numbers `bitcoin-cli getdeploymentinfo` reports.
/// Present only while the deployment status is "started"; None in defined/locked_in/active/failed.
fn parse_signaling(dep: &Option<Value>) -> Option<(i64, i64, i64, f64)> {
    let st = dep
        .as_ref()?
        .get("deployments")?
        .get("reduced_data")?
        .get("bip9")?
        .get("statistics")?;
    let signaled = st.get("count")?.as_i64()?;
    let elapsed = st.get("elapsed")?.as_i64()?;
    let period = st.get("period").and_then(|p| p.as_i64()).unwrap_or(2016);
    let threshold_pct = match st.get("threshold").and_then(|t| t.as_i64()) {
        Some(th) if period > 0 => th as f64 * 100.0 / period as f64,
        _ => 55.0,
    };
    Some((signaled, elapsed, period, threshold_pct))
}
