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
    http::{header, StatusCode},
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use ingest::block_json;
use model::AppState;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::{collections::HashMap, env, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::broadcast;
use tower_http::{compression::CompressionLayer, services::ServeDir, trace::TraceLayer};
use tracing::info;

/// Cache-Control for immutable resources. Every block below the tip is frozen forever and every
/// viewer sees identical bytes, so this is a statement of fact, not an optimistic TTL.
const CC_IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Tip-relative JSON: short TTL collapses a whole audience into a trickle of origin requests while
/// keeping perceived staleness well under one block interval.
const CC_TIP: &str = "public, max-age=5";
/// `/api/state` is the hot path for the CDN-poll fallback; `stale-while-revalidate` lets the edge
/// keep answering during an origin refresh instead of stampeding it.
const CC_STATE: &str = "public, max-age=2, stale-while-revalidate=30";
const CC_NONE: &str = "no-store";

#[derive(Clone)]
struct Ctx {
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<Arc<str>>,
    /// Broadcast on shutdown so WebSocket loops close themselves. Without it graceful shutdown waits
    /// forever: an idle socket has no reason to end on its own.
    shutdown: broadcast::Sender<()>,
    /// A poll older than this means ingest is stalled and the replica should be pulled from rotation.
    ready_max_stale: Duration,
}

#[tokio::main]
async fn main() {
    // Structured logging. RUST_LOG selects levels; the default keeps ingest at info and silences
    // dependency chatter.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "forkwars_backend=info,tower_http=warn,axum::rejection=warn".into()
            }),
        )
        .with_target(true)
        .init();

    let core_url = env::var("CORE_RPC_URL").unwrap_or_else(|_| "http://core:18443".into());
    let knots_url = env::var("KNOTS_RPC_URL").unwrap_or_else(|_| "http://knots:18443".into());
    let user = env::var("RPC_USER").unwrap_or_else(|_| "forkwars".into());
    let pass = env::var("RPC_PASS").unwrap_or_else(|_| "forkwars_regtest".into());
    let poll_ms: u64 = env::var("POLL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let bind = env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "static".into());
    let scheduled_fork_height: Option<i64> = env::var("FORK_AT_HEIGHT").ok().and_then(|s| s.parse().ok());
    let scheduled_fork_label: Option<String> = env::var("FORK_LABEL").ok().filter(|s| !s.is_empty());
    // Unset where difficulty retargeting does not bind (regtest), which disables the ETA's
    // reversion-to-target term and leaves it trusting the measured block rate alone.
    let target_spacing_secs: Option<i64> =
        env::var("TARGET_SPACING_SECS").ok().and_then(|s| s.parse().ok()).filter(|v| *v > 0);
    let retarget_interval: i64 = env::var("RETARGET_INTERVAL")
        .ok().and_then(|s| s.parse().ok()).filter(|v| *v > 0).unwrap_or(2016);
    let floor_height: i64 = env::var("FLOOR_HEIGHT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let db_path = env::var("DB_PATH").ok();
    // Unset = decide by network (regtest only). Forcing it on requires txindex=1 on the node.
    let resolve_prevouts: Option<bool> = env::var("RESOLVE_PREVOUTS")
        .ok()
        .map(|s| matches!(s.trim(), "1" | "true" | "yes" | "on"));
    // How stale the last successful poll may get before readiness fails. Several poll intervals, so
    // one slow poll does not flap a replica out of the load balancer.
    let ready_max_stale = Duration::from_secs(
        env::var("READY_MAX_STALE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60),
    );

    let state = Arc::new(RwLock::new(AppState::default()));

    // Open SQLite (if configured). The in-memory index is warmed from it inside the ingest thread
    // (off the startup critical path) so the HTTP server can begin serving immediately.
    let conn = match db_path.as_deref() {
        Some(p) => match db::open(p) {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::error!(path = p, error = format!("{e:#}"), "could not open db; continuing in-memory");
                None
            }
        },
        None => None,
    };

    let (tx, _rx) = broadcast::channel::<Arc<str>>(64);
    let nodes = ingest::Nodes {
        core: rpc::Rpc::new(&core_url, &user, &pass),
        knots: rpc::Rpc::new(&knots_url, &user, &pass),
        scheduled_fork_height,
        scheduled_fork_label,
        target_spacing_secs,
        retarget_interval,
        floor_height,
        resolve_prevouts,
    };
    ingest::spawn(state.clone(), tx.clone(), nodes, poll_ms, conn);

    let (shutdown, _) = broadcast::channel::<()>(1);
    let ctx = Ctx { state, tx, shutdown: shutdown.clone(), ready_max_stale };
    let app = Router::new()
        // Liveness answers "is the process running"; readiness answers "should this replica receive
        // traffic". Conflating them (a constant `{"ok":true}`) makes every health check decorative:
        // it stays green through a dead ingest, empty state, and both nodes offline.
        .route("/health/live", get(health_live))
        .route("/health/ready", get(health_ready))
        .route("/api/health", get(health_ready)) // legacy path, now meaningful
        .route("/api/state", get(get_state))
        .route("/api/blocks", get(get_blocks))
        .route("/api/blocks/range", get(get_blocks_range))
        .route("/api/blocks/:hash/violations", get(get_violations))
        .route("/ws", get(ws_handler))
        .with_state(ctx)
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true))
        // Block JSON is highly repetitive and compresses ~8x. Applied outside the routes so it
        // covers the static SPA too.
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = bind.parse().expect("invalid BIND address");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    info!(%addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            info!("shutdown signal received; draining");
            let _ = shutdown.send(());
        })
        .await
        .unwrap();
}

/// Resolves on SIGINT or SIGTERM. SIGTERM is the one that matters — it is what an orchestrator sends
/// before the kill timer, and ignoring it means every rolling deploy severs in-flight requests.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

async fn health_live() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, CC_NONE)], Json(json!({ "ok": true, "check": "live" })))
}

/// Ready = the replica has chain data to serve AND the ingest loop completed a pass recently. A
/// stalled ingest looks identical to a healthy one from every other angle, so freshness is the
/// signal worth gating on — it is what C1/C2 failures actually look like.
///
/// Node reachability is deliberately *reported* rather than gated: both nodes are a shared upstream,
/// so failing readiness on them would empty the load balancer of every target at once and turn a
/// degraded-but-serving system into a total outage. Alarm on `core_online`/`knots_online` instead.
async fn health_ready(State(ctx): State<Ctx>) -> impl IntoResponse {
    let (warmed, since_poll, core_online, knots_online, tip) = {
        let s = ctx.state.read();
        (
            // Chain data, not merely a JSON blob: an offline-at-boot process still builds a state
            // snapshot, and serving that as "ready" is the same lie the old constant told.
            !s.state_json.is_null() && s.core_tip_h >= 0,
            s.last_poll_ok.map(|t| t.elapsed()),
            s.core.online,
            s.knots.online,
            s.core_tip_h,
        )
    };
    let fresh = since_poll.map(|d| d <= ctx.ready_max_stale).unwrap_or(false);
    let ok = warmed && fresh;
    let body = json!({
        "ok": ok,
        "check": "ready",
        "state_warmed": warmed,
        // The single most important number in the system: what a frozen ingest looks like.
        "seconds_since_last_poll": since_poll.map(|d| d.as_secs()),
        "max_stale_seconds": ctx.ready_max_stale.as_secs(),
        "core_online": core_online,
        "knots_online": knots_online,
        "tip_height": tip,
    });
    let code = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, [(header::CACHE_CONTROL, CC_NONE)], Json(body))
}

async fn get_state(State(ctx): State<Ctx>) -> impl IntoResponse {
    let s = ctx.state.read();
    if s.state_json.is_null() {
        // Before the first ingest poll populates state, return a valid "still loading" shape so the
        // frontend never dereferences a null state. Not cacheable — it would pin the loading shape
        // at the edge past the point it stops being true.
        return ([(header::CACHE_CONTROL, CC_NONE)], Json(json!({
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
        })));
    }
    ([(header::CACHE_CONTROL, CC_STATE)], Json(s.state_json.clone()))
}

async fn get_blocks(State(ctx): State<Ctx>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let s = ctx.state.read();
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
    // Tip-relative by default, so never immutable — `before` shifts with every new block.
    (
        [(header::CACHE_CONTROL, CC_TIP)],
        Json(json!({ "blocks": blocks, "has_more": has_more, "prune_floor": floor })),
    )
}

/// Blocks present within an inclusive height range [from,to], ascending, skipping gaps (heights not
/// yet backfilled). Used by the isometric scroll view to fill a window around the focus height.
async fn get_blocks_range(State(ctx): State<Ctx>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let s = ctx.state.read();
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
    // A window entirely below the tip can never change again — the aligned chunks the client
    // requests make these keys stable and shared across every viewer. Only the chunk containing the
    // tip is volatile. This split is what makes the scroll-back history essentially free at the edge.
    let cc = if hi < tip { CC_IMMUTABLE } else { CC_TIP };
    (
        [(header::CACHE_CONTROL, cc)],
        Json(json!({
            "blocks": blocks,
            "tip_height": tip,
            "prune_floor": floor,
            "chain": if knots { "knots" } else { "core" },
        })),
    )
}

async fn get_violations(State(ctx): State<Ctx>, Path(hash): Path<String>) -> impl IntoResponse {
    let s = ctx.state.read();
    let found = s.by_hash.get(&hash);
    // Keyed by block hash, so a hit is immutable. A miss is not: the block may simply not be
    // backfilled yet, and caching the empty answer forever would make it permanently wrong.
    let cc = if found.is_some() { CC_IMMUTABLE } else { CC_NONE };
    let vios = found
        .map(|b| serde_json::to_value(&b.violations).unwrap_or_else(|_| Value::Array(vec![])))
        .unwrap_or_else(|| Value::Array(vec![]));
    ([(header::CACHE_CONTROL, cc)], Json(json!({ "hash": hash, "violations": vios })))
}

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<Ctx>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_loop(socket, ctx))
}

/// Pushes the full payload — chain state plus the newest blocks — rather than a bare `{"type":
/// "update"}` ping. The ping contract cost every client three HTTP requests per block, which is the
/// app's dominant traffic source and scales linearly with audience. The frame is precomputed once per
/// poll and shared as an `Arc<str>`, so fan-out is a pointer clone per socket.
async fn ws_loop(mut socket: WebSocket, ctx: Ctx) {
    let mut rx = ctx.tx.subscribe();
    let mut shutdown = ctx.shutdown.subscribe();

    // Current frame on connect, so a fresh client renders without issuing a single API request.
    let initial = ctx.state.read().push_frame.clone();
    let first = match initial {
        Some(f) => f.to_string(),
        // Ingest has not completed a poll yet; the bare ping tells the client to fall back to HTTP.
        None => json!({ "type": "update" }).to_string(),
    };
    if socket.send(Message::Text(first)).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            r = rx.recv() => match r {
                Ok(frame) => {
                    if socket.send(Message::Text(frame.to_string())).await.is_err() {
                        break;
                    }
                }
                // Lagged means we skipped frames. Sending the queued one would push stale state, so
                // resend whatever is current instead.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let cur = ctx.state.read().push_frame.clone();
                    if let Some(frame) = cur {
                        if socket.send(Message::Text(frame.to_string())).await.is_err() {
                            break;
                        }
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
