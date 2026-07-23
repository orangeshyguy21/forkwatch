mod db;
mod ingest;
mod miner;
mod model;
mod rdts;
mod rpc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use ingest::block_json;
use model::AppState;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::{Arc, RwLock},
};
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct Ctx {
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<()>,
}

#[tokio::main]
async fn main() {
    let core_url = env::var("CORE_RPC_URL").unwrap_or_else(|_| "http://core:18443".into());
    let knots_url = env::var("KNOTS_RPC_URL").unwrap_or_else(|_| "http://knots:18443".into());
    let user = env::var("RPC_USER").unwrap_or_else(|_| "forkwars".into());
    let pass = env::var("RPC_PASS").unwrap_or_else(|_| "forkwars_regtest".into());
    let poll_ms: u64 = env::var("POLL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let bind = env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "static".into());
    let scheduled_fork_height: Option<i64> = env::var("FORK_AT_HEIGHT").ok().and_then(|s| s.parse().ok());
    let floor_height: i64 = env::var("FLOOR_HEIGHT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let db_path = env::var("DB_PATH").ok();

    let state = Arc::new(RwLock::new(AppState::default()));

    // Open SQLite (if configured). The in-memory index is warmed from it inside the ingest thread
    // (off the startup critical path) so the HTTP server can begin serving immediately.
    let conn = match db_path.as_deref() {
        Some(p) => match db::open(p) {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[forkwars] could not open db {p}: {e:#} (continuing in-memory)");
                None
            }
        },
        None => None,
    };

    let (tx, _rx) = broadcast::channel::<()>(64);
    let nodes = ingest::Nodes {
        core: rpc::Rpc::new(&core_url, &user, &pass),
        knots: rpc::Rpc::new(&knots_url, &user, &pass),
        scheduled_fork_height,
        floor_height,
    };
    ingest::spawn(state.clone(), tx.clone(), nodes, poll_ms, conn);

    let ctx = Ctx { state, tx };
    let app = Router::new()
        .route("/api/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/api/state", get(get_state))
        .route("/api/blocks", get(get_blocks))
        .route("/api/blocks/range", get(get_blocks_range))
        .route("/api/blocks/:hash/violations", get(get_violations))
        .route("/ws", get(ws_handler))
        .with_state(ctx)
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true));

    let addr: SocketAddr = bind.parse().expect("invalid BIND address");
    println!("[forkwars] listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn get_state(State(ctx): State<Ctx>) -> Json<Value> {
    let s = ctx.state.read().unwrap();
    if s.state_json.is_null() {
        // Before the first ingest poll populates state, return a valid "still loading" shape so the
        // frontend never dereferences a null state.
        return Json(json!({
            "core": s.core,
            "knots": s.knots,
            "agreed": true,
            "syncing": false,
            "lca_height": Value::Null,
            "tip_height": Value::Null,
            "prune_floor": s.core.prune_height.max(0),
            "fork": Value::Null,
            "rdts": { "status": "never", "since_height": Value::Null, "bit": 4 },
            "signaling": { "window": 2016, "signaled": 0, "total": 0, "pct": 0.0, "threshold_pct": 55.0 },
            "scheduled_fork": Value::Null,
        }));
    }
    Json(s.state_json.clone())
}

async fn get_blocks(State(ctx): State<Ctx>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let s = ctx.state.read().unwrap();
    let core_tip_h = s.core_tip_h;
    let floor = s.prune_floor;
    let before: i64 = q.get("before").and_then(|v| v.parse().ok()).unwrap_or(core_tip_h + 1);
    let limit: i64 = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).clamp(1, 500);
    let top = (before - 1).min(core_tip_h);

    let mut blocks = Vec::new();
    let mut h = top;
    while h >= floor && (top - h) < limit {
        match s.core_by_height.get(&h) {
            Some(hash) => {
                if let Some(b) = s.by_hash.get(hash) {
                    blocks.push(block_json(
                        b, &s.core_by_height, &s.knots_by_height, &s.core_tips_status, &s.knots_tips_status,
                    ));
                }
                h -= 1;
            }
            None => break, // reached the lowest backfilled block (or the prune floor)
        }
    }
    // Hard stop at the prune floor: no more history below what the nodes retain.
    let has_more = h >= floor;
    Json(json!({ "blocks": blocks, "has_more": has_more, "prune_floor": floor }))
}

/// Blocks present within an inclusive height range [from,to], ascending, skipping gaps (heights not
/// yet backfilled). Used by the isometric scroll view to fill a window around the focus height.
async fn get_blocks_range(State(ctx): State<Ctx>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let s = ctx.state.read().unwrap();
    // Serve either node's view of the chain: chain=knots follows the Knots (RDTS) chain, else Core.
    let knots = q.get("chain").map(|c| c == "knots").unwrap_or(false);
    let by_height = if knots { &s.knots_by_height } else { &s.core_by_height };
    let tip = if knots { s.knots_tip_h } else { s.core_tip_h };
    let floor = s.prune_floor;
    let from: i64 = q.get("from").and_then(|v| v.parse().ok()).unwrap_or(floor).max(floor);
    let to: i64 = q.get("to").and_then(|v| v.parse().ok()).unwrap_or(tip).min(tip);
    let (lo, hi0) = if from <= to { (from, to) } else { (to, from) };
    let hi = hi0.min(lo + 600); // cap window size

    let mut blocks = Vec::new();
    let mut h = lo;
    while h <= hi {
        if let Some(hash) = by_height.get(&h) {
            if let Some(b) = s.by_hash.get(hash) {
                blocks.push(block_json(
                    b, &s.core_by_height, &s.knots_by_height, &s.core_tips_status, &s.knots_tips_status,
                ));
            }
        }
        h += 1;
    }
    Json(json!({
        "blocks": blocks,
        "tip_height": tip,
        "prune_floor": floor,
        "chain": if knots { "knots" } else { "core" },
    }))
}

async fn get_violations(State(ctx): State<Ctx>, Path(hash): Path<String>) -> Json<Value> {
    let s = ctx.state.read().unwrap();
    let vios = s
        .by_hash
        .get(&hash)
        .map(|b| serde_json::to_value(&b.violations).unwrap_or_else(|_| Value::Array(vec![])))
        .unwrap_or_else(|| Value::Array(vec![]));
    Json(json!({ "hash": hash, "violations": vios }))
}

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<Ctx>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_loop(socket, ctx))
}

async fn ws_loop(mut socket: WebSocket, ctx: Ctx) {
    let mut rx = ctx.tx.subscribe();
    let _ = socket.send(Message::Text(json!({"type":"update"}).to_string())).await;
    loop {
        tokio::select! {
            r = rx.recv() => match r {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(json!({"type":"update"}).to_string())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(_)) => {}
                _ => break,
            },
        }
    }
}
