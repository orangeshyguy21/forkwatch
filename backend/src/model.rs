use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

/// Aggregated RDTS violation: a rule+kind and how many outputs in the block hit it. We do NOT store
/// per-transaction detail — just the type and count.
#[derive(Clone, Serialize, Deserialize)]
pub struct Violation {
    pub rule: u8,
    pub kind: String,
    pub count: i64,
}

/// Static block metadata we persist. Per-node chain status (active/invalid/…) is dynamic and
/// computed at serve time, so it is NOT stored on the block.
#[derive(Clone)]
pub struct Block {
    pub height: i64,
    pub hash: String,
    pub prev_hash: String,
    pub time: i64,
    pub size: i64,
    pub weight: i64,
    pub tx_count: i64,
    pub version: i64,
    pub signals_110: bool,
    pub rdts_verdict: String, // pass | would_violate | invalid | unscanned
    pub rdts_rule_hits: Vec<u8>,
    pub violations: Vec<Violation>,
    /// Mining pool that produced the block, if attributable from the coinbase (None for pruned
    /// history whose raw block was never captured, or unrecognized pools).
    pub miner: Option<String>,
    /// Printable ASCII from the coinbase scriptSig (the pool's tag), if any.
    pub coinbase_tag: Option<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct NodeInfo {
    pub label: String,
    /// Network the node is on ("main" | "test" | "signet" | "regtest"). Drives capability decisions
    /// that must not be inferred from chain state — notably whether prevout resolution (which needs
    /// `txindex=1`) is affordable at all.
    pub chain: String,
    pub version: String,
    pub blocks: i64,
    pub headers: i64,
    pub bestblockhash: String,
    pub connections: i64,
    pub online: bool,
    pub pruned: bool,
    pub prune_height: i64,
    pub verification_progress: f64,
    pub ibd: bool,
}

#[derive(Default)]
pub struct AppState {
    pub by_hash: HashMap<String, Block>,
    pub core_by_height: HashMap<i64, String>,  // height -> hash on Core's active chain
    pub knots_by_height: HashMap<i64, String>, // height -> hash on Knots's active chain
    pub core_tips_status: HashMap<String, String>,  // getchaintips hash -> status (Core)
    pub knots_tips_status: HashMap<String, String>, // getchaintips hash -> status (Knots)
    pub core_tip_h: i64,
    pub knots_tip_h: i64,
    /// Highest block common to both chains (the fork's last common ancestor). Equals the tip when the
    /// nodes agree; below it when they have forked; -1/0 before the first poll. A block strictly below
    /// this height is final on BOTH chains — its per-node status can no longer change — which is what
    /// lets `/api/blocks/range` mark deep history immutable without freezing volatile fork state.
    pub lca_height: i64,
    pub prune_floor: i64, // lowest servable height (hard stop = node prune height)
    pub core: NodeInfo,
    pub knots: NodeInfo,
    pub state_json: serde_json::Value,
    /// Pre-serialized `/api/state` body, rebuilt once per poll. Serving this shared `Arc<str>` avoids
    /// deep-cloning the whole state `Value` (hundreds of KB during a fork) under the read lock on
    /// every request — the clone+reserialize was per-request work that compounded read-lock residence.
    pub state_json_str: Option<Arc<str>>,
    /// The full WebSocket push frame (state + the newest blocks), rebuilt once per poll and shared by
    /// every connected client. Pushing it means a block costs each client zero HTTP requests.
    pub push_frame: Option<Arc<str>>,
    /// When the ingest loop last completed a poll that reached both nodes. `None` until the first one
    /// lands. This is the readiness signal — a frozen ingest is invisible in every other metric.
    pub last_poll_ok: Option<Instant>,
}
