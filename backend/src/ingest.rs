use crate::db;
use crate::model::{AppState, Block, NodeInfo};
use crate::rdts;
use crate::rpc::Rpc;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;
use tokio::sync::broadcast;

const TIP_MAX: usize = 1000; // max new blocks pulled from a tip per poll
const BACKFILL_BATCH: usize = 200; // older blocks pulled toward the prune floor per poll
const MINER_BACKFILL_BATCH: usize = 40; // retained blocks re-scanned for coinbase/miner data per poll

pub struct Nodes {
    pub core: Rpc,
    pub knots: Rpc,
    pub scheduled_fork_height: Option<i64>,
    /// Hard floor for the visualization: never ingest/serve below this height (0 = node prune floor).
    /// Focuses the app on a relevant window (e.g. the first epoch RDTS signaling was possible).
    pub floor_height: i64,
}

pub fn spawn(
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<()>,
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
                    let mut g = state.write().unwrap();
                    for b in blocks {
                        g.by_hash.insert(b.hash.clone(), b);
                    }
                    drop(g);
                    println!("[ingest] warmed {n} blocks from db");
                    let _ = tx.send(());
                }
                Err(e) => eprintln!("[ingest] db load_all failed: {e:#}"),
            }
        }
        loop {
            match poll_once(&state, &nodes, conn.as_ref()) {
                Ok(changed) => {
                    if changed {
                        let _ = tx.send(());
                    }
                }
                Err(e) => eprintln!("[ingest] poll error: {e:#}"),
            }
            thread::sleep(Duration::from_millis(poll_ms));
        }
    });
}

fn poll_once(state: &Arc<RwLock<AppState>>, nodes: &Nodes, conn: Option<&Connection>) -> anyhow::Result<bool> {
    let core_info = node_info(&nodes.core, "Bitcoin Core").unwrap_or_else(|e| {
        eprintln!("[ingest] core offline: {e:#}");
        NodeInfo { label: "Bitcoin Core".into(), online: false, ..Default::default() }
    });
    let knots_info = node_info(&nodes.knots, "Bitcoin Knots").unwrap_or_else(|e| {
        eprintln!("[ingest] knots offline: {e:#}");
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

    let mut changed = false;

    // 1. Tip sync (short; usually 0-1 new blocks). Held under the write lock.
    {
        let mut g = state.write().unwrap();
        let a = fetch_tip_down(&nodes.core, &core_info.bestblockhash, core_info.blocks, &mut g.by_hash, conn, backfill_target, activation, TIP_MAX);
        let b = fetch_tip_down(&nodes.knots, &knots_info.bestblockhash, knots_info.blocks, &mut g.by_hash, conn, backfill_target, activation, TIP_MAX);
        changed = a > 0 || b > 0;
    }

    // 1b. Miner backfill for the node's still-retained near-tip window. Blocks cached before this
    // feature existed (and freshly warmed history within the node's retained range) carry no
    // coinbase-derived miner data — coinbase_tag is NULL. Re-derive it for a bounded batch of the
    // newest such blocks each poll; over a few polls the retained window fills in. Blocks below the
    // node's prune height are gone and can't be re-fetched, so they're never candidates.
    {
        let retain_floor = core_info.prune_height.max(0);
        let candidates: Vec<(String, i64)> = {
            let g = state.read().unwrap();
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
                .filter_map(|(hash, h)| fetch_one(&nodes.core, &hash, h, activation))
                .collect();
            if !refreshed.is_empty() {
                let mut g = state.write().unwrap();
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
        let g = state.read().unwrap();
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
        let fetched = fetch_batch(&nodes.core, &parent, ph, backfill_target, activation, BACKFILL_BATCH);
        if !fetched.is_empty() {
            let mut g = state.write().unwrap();
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
        let mut g = state.write().unwrap();
        let knots_map = build_height_map(&g.by_hash, &knots_info.bestblockhash);
        if let Some(&low) = knots_map.keys().min() {
            if low > backfill_target {
                let parent = knots_map
                    .get(&low)
                    .and_then(|hash| g.by_hash.get(hash))
                    .map(|b| b.prev_hash.clone());
                if let Some(parent) = parent {
                    let n = fetch_tip_down(
                        &nodes.knots, &parent, low - 1, &mut g.by_hash, conn, backfill_target, activation, BACKFILL_BATCH,
                    );
                    if n > 0 {
                        changed = true;
                    }
                }
            }
        }
    }

    // 3. Rebuild chain maps + state snapshot under the write lock.
    {
        let mut g = state.write().unwrap();
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

        changed = changed
            || core_info.bestblockhash != g.core.bestblockhash
            || knots_info.bestblockhash != g.knots.bestblockhash
            || core_info.blocks != g.core.blocks
            || core_info.online != g.core.online
            || knots_info.online != g.knots.online;

        let mut sj = build_state_json(
            &g.by_hash, &core_map, &knots_map, &core_info, &knots_info, &core_tips, &knots_tips,
            &rdts_status, rdts_since, rdts_bit, nodes.scheduled_fork_height, core_tip_h, knots_tip_h,
            serve_floor, signaling_stats,
        );
        // The CONFIGURED display floor (0 = none). The rail spans [floor_height, tip] to draw the full
        // epoch structure even when the node has only pruned-retained a thin near-tip window; the app
        // shades [floor_height, prune_floor) as not-yet-cached. Distinct from prune_floor (data floor).
        if let Some(o) = sj.as_object_mut() {
            o.insert("floor_height".to_string(), json!(nodes.floor_height));
        }

        g.core_by_height = core_map;
        g.knots_by_height = knots_map;
        g.core_tips_status = core_tips;
        g.knots_tips_status = knots_tips;
        g.core_tip_h = core_tip_h;
        g.knots_tip_h = knots_tip_h;
        g.prune_floor = serve_floor;
        g.core = core_info;
        g.knots = knots_info;
        g.state_json = sj;
    }

    Ok(changed)
}

fn node_info(rpc: &Rpc, label: &str) -> anyhow::Result<NodeInfo> {
    let bci = rpc.call("getblockchaininfo", json!([]))?;
    let ni = rpc.call("getnetworkinfo", json!([])).unwrap_or(Value::Null);
    let conns = rpc.call("getconnectioncount", json!([])).ok().and_then(|v| v.as_i64()).unwrap_or(0);
    Ok(NodeInfo {
        label: label.to_string(),
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

/// Walk from a tip toward the prune floor, fetching+persisting blocks not yet in `by_hash`. Height is
/// tracked from `tip_height` and decremented per step (a serialized block doesn't carry its height).
/// Stops at a known block, the prune floor, an RPC error (pruned/unavailable), or after `max`.
#[allow(clippy::too_many_arguments)]
fn fetch_tip_down(
    rpc: &Rpc,
    tip: &str,
    tip_height: i64,
    by_hash: &mut HashMap<String, Block>,
    conn: Option<&Connection>,
    floor: i64,
    activation: Option<i64>,
    max: usize,
) -> usize {
    if is_zero_hash(tip) {
        return 0;
    }
    let mut cur = tip.to_string();
    let mut height = tip_height;
    let mut n = 0;
    while n < max && height >= floor && !is_zero_hash(&cur) && !by_hash.contains_key(&cur) {
        let Some(block) = fetch_one(rpc, &cur, height, activation) else { break };
        let prev = block.prev_hash.clone();
        if let Some(c) = conn {
            let _ = db::upsert(c, &block);
        }
        by_hash.insert(block.hash.clone(), block);
        n += 1;
        height -= 1;
        cur = prev;
    }
    n
}

/// Lock-free walk of up to `max` blocks down from `start_hash` (`start_height`) toward the prune floor.
fn fetch_batch(
    rpc: &Rpc,
    start_hash: &str,
    start_height: i64,
    floor: i64,
    activation: Option<i64>,
    max: usize,
) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur = start_hash.to_string();
    let mut height = start_height;
    while out.len() < max && height >= floor && !is_zero_hash(&cur) {
        let Some(block) = fetch_one(rpc, &cur, height, activation) else { break };
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
fn fetch_one(rpc: &Rpc, hash: &str, height: i64, activation: Option<i64>) -> Option<Block> {
    let raw = rpc.call("getblock", json!([hash, 0])).ok()?;
    let hexs = raw.as_str()?;
    let bytes = hex::decode(hexs).ok()?;
    let b: bitcoin::Block = bitcoin::consensus::deserialize(&bytes).ok()?;
    let version = b.header.version.to_consensus() as i64;
    let signals_110 = (version & 0x2000_0000) != 0 && (version & (1 << 4)) != 0;
    // Rule 3 needs the spent outputs' scriptPubKeys — resolve them only for post-activation blocks
    // (regtest demo territory, where txindex is on). Everything else is witness-only.
    let prevouts = if activation.map(|a| height >= a).unwrap_or(false) {
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
/// version). Uses `getrawtransaction <txid> true` — works on regtest (txindex=1); best-effort, any
/// input that can't be resolved is simply skipped. Only called for post-activation blocks, which in
/// practice only occur on the small regtest demo chain, so the extra RPCs are cheap.
fn resolve_prevouts(rpc: &Rpc, block: &bitcoin::Block) -> HashMap<bitcoin::OutPoint, bitcoin::ScriptBuf> {
    let mut map = HashMap::new();
    for tx in &block.txdata {
        if tx.is_coinbase() {
            continue;
        }
        for txin in &tx.input {
            let op = txin.previous_output;
            if map.contains_key(&op) {
                continue;
            }
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

    // Distinguish a REAL fork from mere sync lag (one node just behind on the same chain).
    // Real fork = Knots marks Core's tip invalid, or both nodes have blocks above the common ancestor.
    let knots_rejects_core = knots_tips.get(&core.bestblockhash).map(|s| s == "invalid").unwrap_or(false);
    let both_diverge = lca >= 0 && lca < core_tip_h && lca < knots_tip_h;
    let have_both = !core.bestblockhash.is_empty() && !knots.bestblockhash.is_empty();
    let real_fork = have_both && !agreed && (knots_rejects_core || both_diverge);
    let syncing = have_both && !agreed && !real_fork;

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
        "lca_height": if lca >= 0 { Value::from(lca) } else { Value::Null },
        "tip_height": tip_height,
        "prune_floor": prune_floor,
        "fork": fork,
        "rdts": { "status": rdts_status, "since_height": rdts_since, "bit": rdts_bit },
        "signaling": {
            "window": window, "signaled": signaled, "total": total,
            "pct": pct, "threshold_pct": threshold_pct
        },
        "scheduled_fork": scheduled_fork_height.map(|fh| json!({
            "height": fh,
            "blocks_until": (fh - core_tip_h).max(0),
            "reached": !agreed || core_tip_h >= fh,
        })).unwrap_or(Value::Null),
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
