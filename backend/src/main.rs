mod db;
mod ingest;
mod miner;
mod model;
mod rdts;
mod rpc;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use ingest::block_json;
use model::AppState;
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::{collections::HashMap, env, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};
use tower::{limit::ConcurrencyLimitLayer, ServiceBuilder};
use tower_http::{
    compression::CompressionLayer, services::ServeDir, set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer, trace::TraceLayer,
};
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

/// How far below the tip a block must sit before a `/api/blocks/range` window may be marked
/// immutable. A reorg shallower than this can still rewrite the block at a given height (changing the
/// bytes served for a URL we would otherwise freeze for a year); deeper reorgs do not happen in
/// practice. Below this horizon AND below the fork's last common ancestor, the response is final.
const FINAL_DEPTH: i64 = 100;
/// Default ceiling on concurrent WebSocket connections (override with WS_MAX_CONNS). Each socket
/// holds a broadcast subscriber and an outbound buffer, so an unbounded count is a memory-exhaustion
/// lever for an unauthenticated endpoint. Excess upgrade attempts get a 503 and the client's poll
/// fallback keeps them served.
const WS_MAX_CONNS_DEFAULT: usize = 5000;
/// The SPA entry document must be revalidated on every load. It names the content-hashed asset
/// bundles, so a heuristically-cached copy pointing at hashes that a deploy has since replaced
/// renders a blank page — the classic post-deploy white screen, and one that persists for as long
/// as the browser keeps guessing a freshness lifetime for a document that never sent one.
const CC_HTML: &str = "no-cache";
/// Default request timeout (override with REQUEST_TIMEOUT_SECS). Without one, a wedged handler
/// holds its connection forever and slow requests accumulate until the process runs out of sockets.
const REQUEST_TIMEOUT_SECS_DEFAULT: u64 = 20;
/// Default ceiling on concurrently in-flight HTTP requests (override with MAX_INFLIGHT_REQUESTS).
/// A spike then costs latency (and, past the timeout, shed load) instead of unbounded memory.
const MAX_INFLIGHT_DEFAULT: usize = 512;

/// Content-Security-Policy for the SPA.
///
/// `style-src` needs 'unsafe-inline' because the isometric layout positions blocks with inline
/// style attributes; scripts get no such exemption, which is where it matters — coinbase text is
/// attacker-influenced data rendered into this page. `connect-src` names ws/wss so the push socket
/// is not blocked, and `frame-ancestors 'none'` stops the dashboard being framed for clickjacking.
const CSP: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data:; \
font-src 'self' data:; \
connect-src 'self' ws: wss:; \
base-uri 'self'; \
form-action 'none'; \
frame-ancestors 'none'; \
object-src 'none'";

#[derive(Clone)]
struct Ctx {
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<Arc<str>>,
    /// Broadcast on shutdown so WebSocket loops close themselves. Without it graceful shutdown waits
    /// forever: an idle socket has no reason to end on its own.
    shutdown: broadcast::Sender<()>,
    /// A poll older than this means ingest is stalled and the replica should be pulled from rotation.
    ready_max_stale: Duration,
    /// Caps concurrent WebSocket connections. A permit is held for each socket's lifetime; when none
    /// are free the upgrade is refused with 503 rather than accepted into unbounded memory.
    ws_conns: Arc<Semaphore>,
}

/// Read a numeric env var, falling back to `default`.
///
/// A var that is set but unparseable is logged rather than silently ignored: the process would
/// otherwise come up looking healthy on a default the operator believes they overrode, which is the
/// worst of both outcomes. `FW_`-prefixed compose vars arrive here already stripped of the prefix.
fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    let Ok(raw) = env::var(key) else { return default };
    match raw.trim().parse() {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!(key, value = %raw, "not a number; using default");
            default
        }
    }
}

/// Same, but for knobs where a non-positive value is meaningless — an interval, a timeout, a cap.
/// These guards used to be applied by hand and inconsistently: six sites had them and four did not,
/// with nothing at the call site to say which was which.
fn env_positive<T: std::str::FromStr + PartialOrd + Default>(key: &str, default: T) -> T {
    let v = env_num(key, T::default());
    if v > T::default() {
        return v;
    }
    default
}

/// Optional numeric env var — absent and unset mean the same thing to the caller.
fn env_opt<T: std::str::FromStr>(key: &str) -> Option<T> {
    env::var(key).ok().and_then(|s| s.trim().parse().ok())
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
    // The default password is a regtest convenience only. On any non-regtest network a missing
    // RPC_PASS is an operator error that must fail loudly, not silently authenticate with a value
    // that is public in this repo's history — a working-looking process on a guessable credential is
    // worse than a crash on boot.
    let pass = match env::var("RPC_PASS") {
        Ok(p) if !p.is_empty() => p,
        _ => {
            let net = env::var("NETWORK").unwrap_or_default();
            if net.is_empty() || net == "regtest" {
                "forkwars_regtest".into()
            } else {
                panic!("RPC_PASS must be set on NETWORK={net}; refusing to start with the public default password");
            }
        }
    };
    let poll_ms: u64 = env_positive("POLL_MS", 2000);
    let bind = env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "static".into());
    let scheduled_fork_height: Option<i64> = env_opt("FORK_AT_HEIGHT");
    let scheduled_fork_label: Option<String> = env::var("FORK_LABEL").ok().filter(|s| !s.is_empty());
    // Unset where difficulty retargeting does not bind (regtest), which disables the ETA's
    // reversion-to-target term and leaves it trusting the measured block rate alone.
    let target_spacing_secs: Option<i64> = env_opt::<i64>("TARGET_SPACING_SECS").filter(|v| *v > 0);
    let retarget_interval: i64 = env_positive("RETARGET_INTERVAL", 2016);
    // Zero is a legitimate floor (serve from genesis), so this clamps rather than rejecting.
    let floor_height: i64 = env_num("FLOOR_HEIGHT", 0).max(0);
    let db_path = env::var("DB_PATH").ok();
    // Unset = decide by network (regtest only). Forcing it on requires txindex=1 on the node.
    let resolve_prevouts: Option<bool> = env::var("RESOLVE_PREVOUTS")
        .ok()
        .map(|s| matches!(s.trim(), "1" | "true" | "yes" | "on"));
    // How stale the last successful poll may get before readiness fails. Several poll intervals, so
    // one slow poll does not flap a replica out of the load balancer.
    let ready_max_stale = Duration::from_secs(env_positive("READY_MAX_STALE_SECS", 60));
    let ws_max_conns: usize = env_positive("WS_MAX_CONNS", WS_MAX_CONNS_DEFAULT);
    let request_timeout =
        Duration::from_secs(env_positive("REQUEST_TIMEOUT_SECS", REQUEST_TIMEOUT_SECS_DEFAULT));
    let max_inflight: usize = env_positive("MAX_INFLIGHT_REQUESTS", MAX_INFLIGHT_DEFAULT);

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
    let ctx = Ctx {
        state,
        tx,
        shutdown: shutdown.clone(),
        ready_max_stale,
        ws_conns: Arc::new(Semaphore::new(ws_max_conns)),
    };
    // /ws is deliberately kept OUT of the timeout and concurrency layers below. A WebSocket is a
    // long-lived connection by design: a request timeout would sever every socket at the deadline,
    // and a concurrency permit held for the life of a socket would exhaust the limit with a handful
    // of viewers. Socket count is bounded separately, by WS_MAX_CONNS inside ws_handler.
    let ws_routes = Router::new().route("/ws", get(ws_handler));

    let request_routes = Router::new()
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
        // Bound time and in-flight work. Cloudflare rate-limiting is the first line of defence, but
        // it is bypassable by cache-busting query strings (?before=<random>), which reach the origin
        // unthrottled — so the origin needs its own ceiling rather than trusting the edge.
        .layer(TimeoutLayer::new(request_timeout))
        .layer(ConcurrencyLimitLayer::new(max_inflight));

    // Content-hashed by vite (index-BqKSeg4b.js), so the bytes at any /assets URL never change:
    // freezing them is what makes the no-cache on index.html cheap.
    let assets_service = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static(CC_IMMUTABLE),
        ))
        .service(ServeDir::new(format!("{static_dir}/assets")));

    let spa_service = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static(CC_HTML),
        ))
        .service(ServeDir::new(&static_dir).append_index_html_on_directories(true));

    let app = ws_routes
        .merge(request_routes)
        .with_state(ctx)
        .nest_service("/assets", assets_service)
        .fallback_service(spa_service)
        // Security headers on every response, static included. `overriding` so a handler cannot
        // accidentally weaken them.
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        // Ignored by browsers over plain HTTP (so the LAN nginx path is unaffected) and honoured
        // once Cloudflare terminates TLS. No includeSubDomains: this host should not dictate policy
        // for siblings it does not control.
        .layer(SetResponseHeaderLayer::overriding(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        ))
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
    // Build provenance is part of liveness on purpose: without it, "is the fix actually deployed?"
    // can only be inferred from image timestamps, which is how a stale binary survives a review.
    // Stamped at image build time (Dockerfile ARG GIT_SHA -> ENV FW_GIT_SHA); "unknown" when the
    // build arg was not passed, which is itself the signal that the deploy path skipped it.
    (
        [(header::CACHE_CONTROL, CC_NONE)],
        Json(json!({
            "ok": true,
            "check": "live",
            "version": env!("CARGO_PKG_VERSION"),
            "commit": env::var("FW_GIT_SHA").unwrap_or_else(|_| "unknown".to_string()),
        })),
    )
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

async fn get_state(State(ctx): State<Ctx>) -> Response {
    // Clone the shared Arc (cheap) and release the lock immediately; the response body is built from
    // it without re-serializing. Before the first poll it is None -> the loading shape below.
    let cached = {
        let s = ctx.state.read();
        s.state_json_str.clone().ok_or_else(|| json!({
            // Before the first ingest poll populates state, return a valid "still loading" shape so
            // the frontend never dereferences a null state. Not cacheable — it would pin the loading
            // shape at the edge past the point it stops being true.
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
        }))
    };
    match cached {
        Ok(body) => (
            [
                (header::CACHE_CONTROL, CC_STATE),
                (header::CONTENT_TYPE, "application/json"),
            ],
            Body::from(body.to_string()),
        ).into_response(),
        Err(loading) => ([(header::CACHE_CONTROL, CC_NONE)], Json(loading)).into_response(),
    }
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
    let mut all_backfilled = true;
    let mut h = lo;
    while h <= hi {
        if let Some(hash) = by_height.get(&h) {
            if let Some(b) = s.by_hash.get(hash) {
                // A block whose coinbase-derived miner data has not been resolved yet is still
                // changing (step 1b re-fetches it each poll until coinbase_tag lands), so a window
                // containing one must not be frozen.
                all_backfilled &= b.coinbase_tag.is_some();
                blocks.push(block_json(
                    b, &s.core_by_height, &s.knots_by_height, &s.core_tips_status, &s.knots_tips_status,
                ));
            }
        }
        h += 1;
    }
    // Immutability is a claim of finality, and the block JSON carries three things that can still
    // change below the raw tip: per-node status (`core_status`/`knots_status`, recomputed from the
    // live chain maps), miner backfill, and the very hash at a height (a reorg). Freeze a window ONLY
    // when all of these are settled:
    //   - no gaps: every height in [lo,hi] was present, so we are not caching a half-filled window
    //     that fills in later;
    //   - all_backfilled: every block's miner data is resolved;
    //   - below the last common ancestor: at/above the LCA a node's status flips as a fork develops;
    //     strictly below it both chains agree forever;
    //   - FINAL_DEPTH below the shallower tip: no reorg can still rewrite the height.
    // Otherwise it is tip-relative (short TTL), never immutable.
    let min_tip = s.core_tip_h.min(s.knots_tip_h);
    let no_gaps = !blocks.is_empty() && blocks.len() as i64 == hi - lo + 1;
    let below_lca = s.lca_height >= 0 && hi < s.lca_height;
    let final_window = no_gaps && all_backfilled && below_lca && hi <= min_tip - FINAL_DEPTH;
    let cc = if final_window { CC_IMMUTABLE } else { CC_TIP };
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

async fn ws_handler(ws: WebSocketUpgrade, State(ctx): State<Ctx>) -> Response {
    // Refuse the upgrade if we are at the connection ceiling — better a 503 (the client falls back to
    // polling, which the edge cache absorbs) than accepting unbounded sockets into memory.
    let permit = match ctx.ws_conns.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "websocket capacity reached").into_response(),
    };
    // The protocol is push-only: inbound frames are read solely to detect a client close, then
    // discarded. Cap them hard so a client cannot make the server buffer (and UTF-8-validate) a
    // multi-megabyte message before it is thrown away — the default is 64 MiB per message.
    ws.max_message_size(4 * 1024)
        .max_frame_size(4 * 1024)
        .on_upgrade(move |socket| ws_loop(socket, ctx, permit))
}

/// Pushes the full payload — chain state plus the newest blocks — rather than a bare `{"type":
/// "update"}` ping. The ping contract cost every client three HTTP requests per block, which is the
/// app's dominant traffic source and scales linearly with audience. The frame is precomputed once per
/// poll and shared as an `Arc<str>`, so fan-out is a pointer clone per socket.
async fn ws_loop(mut socket: WebSocket, ctx: Ctx, _permit: OwnedSemaphorePermit) {
    // `_permit` is held for the whole connection; dropping it here (on any break/return below)
    // returns the slot to the semaphore so a new client can connect.
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
