#!/usr/bin/env bash
# Forkwatch regtest control surface. One place to tweak the simulated chain and rebuild to it.
#
#   bash scripts/regtest.sh reset                    # wipe + rebuild to compose/regtest.env
#   bash scripts/regtest.sh reset LEAD_BLOCKS=20     # ...with one-off overrides
#   bash scripts/regtest.sh status                   # where is the chain now
#   bash scripts/regtest.sh fork-now                 # stop waiting, fork this second
#   bash scripts/regtest.sh restore                  # back to the pre-fork snapshot (seconds)
#
# Persistent parameters live in compose/regtest.env. Overrides passed as KEY=VALUE args are saved
# into compose/.regtest.runtime.env alongside the derived FLOOR_HEIGHT, so `up`/`restart` after a
# reset reuse exactly the state you built.
#
# At mainnet heights a `reset` mines ~961,632 blocks and takes a couple of hours, so it is NOT the
# loop you iterate in. The loop is: reset ONCE (which ends by saving a snapshot of the parked
# pre-fork chain), then `restore` before each run of the fork. See cmd_snapshot below.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
COMPOSE_FILE="$HERE/compose/docker-compose.regtest.yml"
PARAMS="$HERE/compose/regtest.env"
RUNTIME="$HERE/compose/.regtest.runtime.env"
# Where `snapshot` writes and `restore` reads. Under snapshots/, which .gitignore already excludes —
# these are multi-gigabyte tarballs of the node datadirs.
SNAPDIR="$HERE/snapshots/regtest"
DEFAULT_SNAP=prefork
# The three docker volumes that ARE the regtest state. Names are pinned in the compose file, so the
# `forkwars-regtest_` prefix is literal, not derived from the compose project name.
SNAP_VOLS="core-data knots-data app-db"
# The shared secrets file (compose/.env) — the ONLY place FW_RPC_PASS/FW_RPC_USER live. The nodes are
# brought up with it, so the app/miner must see it too or their RPC auth silently mismatches the
# nodes (getblockchaininfo -> "EOF while parsing", app shows OFFLINE / tip -1). It carries only
# FW_-prefixed keys the regtest compose never reads, plus those two creds — and it is loaded FIRST so
# PARAMS/RUNTIME still win any key. Optional: a fresh checkout without it falls back to the compose
# defaults, exactly as before.
MAIN_ENV="$HERE/compose/.env"

# Build provenance for the app image (Dockerfile ARG GIT_SHA -> /health/live .commit), so a regtest
# container can be tied to a commit the same way prod is. Dirty trees are marked.
GIT_SHA="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$HERE" diff --quiet HEAD 2>/dev/null || GIT_SHA="${GIT_SHA}-dirty"
export GIT_SHA

dc() {
  local main_env=()
  [ -f "$MAIN_ENV" ] && main_env=(--env-file "$MAIN_ENV")
  docker compose "${main_env[@]}" --env-file "$PARAMS" --env-file "$RUNTIME" -f "$COMPOSE_FILE" "$@"
}
C()  { docker exec fw-core  bitcoin-cli -datadir=/data "$@"; }
K()  { docker exec fw-knots bitcoin-cli -datadir=/data "$@"; }

touch "$RUNTIME"

# Effective value of a parameter: runtime override wins over compose/regtest.env.
param() {
  local key="$1" v=""
  v=$(grep -E "^${key}=" "$RUNTIME" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  [ -n "$v" ] || v=$(grep -E "^${key}=" "$PARAMS" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  printf '%s' "$v"
}

# Replace (or append) KEY=VALUE in the runtime override file.
put() {
  local key="${1%%=*}" line="$1"
  grep -vE "^${key}=" "$RUNTIME" > "$RUNTIME.tmp" 2>/dev/null || true
  printf '%s\n' "$line" >> "$RUNTIME.tmp"
  mv "$RUNTIME.tmp" "$RUNTIME"
}

wait_healthy() {
  for n in "$@"; do
    printf '  waiting for %s' "$n"
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$n" 2>/dev/null)" = "healthy" ]; do
      printf '.'; sleep 1
    done
    printf ' healthy\n'
  done
}

# Block until the app has walked its history all the way down to the display floor. Only worth
# waiting for before a snapshot: capturing a half-backfilled SQLite means every restore pays the
# backfill again (BACKFILL_BATCH blocks per poll — minutes, at a 17-epoch window).
wait_backfill() {
  local floor="$1" pf="" i
  echo "  waiting for the app to backfill down to $floor"
  for i in $(seq 1 2400); do
    pf=$(curl -sf --max-time 5 http://localhost:8080/api/state 2>/dev/null \
         | python3 -c 'import sys,json;print(json.load(sys.stdin).get("prune_floor",""))' \
         2>/dev/null || true)
    # Equality, not <=. The app reports prune_floor 0 until its first ingest cycle lands, and a
    # `<= floor` test happily matches that zero — snapshotting an empty database. Once anything is
    # cached the app clamps its serve floor to FLOOR_HEIGHT, so a complete backfill reports the
    # floor exactly.
    if [ -n "$pf" ] && [ "$pf" = "$floor" ]; then
      echo "  backfill complete (floor $pf)"; return 0
    fi
    [ $((i % 15)) -eq 0 ] && echo "    at ${pf:-?} -> $floor"
    sleep 2
  done
  echo "  WARNING: backfill did not finish in time; snapshotting anyway (floor ${pf:-?})"
}

vol() { printf 'forkwars-regtest_%s' "$1"; }

# --- snapshots ------------------------------------------------------------------------------------
# Tar the three volumes to disk so a 961,632-block chain is mined once and replayed forever.
#
# Deliberately uncompressed: restore latency is what this exists to minimize, and gzip would add a
# minute at each end to save disk that this box has. Budget ~3.5 GB per snapshot at mainnet heights.
#
# The stack is stopped for the duration. Copying a live bitcoind datadir captures leveldb mid-write,
# and the node that comes back from THAT tarball is corrupt in ways that surface hours later.
cmd_snapshot() {
  # Split declarations: `local a=$1 b=$a` expands the whole word list before any of it is assigned,
  # so `b` would see an unset `a` — fatal under `set -u`.
  local name="${1:-$DEFAULT_SNAP}"
  local dir="$SNAPDIR/$name" v ch kh tip
  case "$name" in */*|"") echo "bad snapshot name: $name"; exit 1;; esac

  # Heights while the nodes still answer; the metadata is written after they are down.
  ch=$(C getblockcount 2>/dev/null || echo '?')
  kh=$(K getblockcount 2>/dev/null || echo '?')
  tip=$(C getblockheader "$(C getbestblockhash 2>/dev/null)" 2>/dev/null \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["time"])' 2>/dev/null || echo 0)

  echo "### snapshotting '$name' (core $ch / knots $kh) ###"
  dc down >/dev/null 2>&1 || true
  rm -rf "$dir"; mkdir -p "$dir"
  for v in $SNAP_VOLS; do
    printf '  packing %-12s' "$v"
    # chown inside the same container: tar has to run as root to read the datadirs (uid 1000/10001),
    # which would otherwise leave root-owned tarballs the user cannot delete without sudo.
    docker run --rm -v "$(vol "$v"):/src:ro" -v "$dir:/out" alpine \
      sh -c "tar -C /src -cf /out/$v.tar . && chown $(id -u):$(id -g) /out/$v.tar"
    printf '%s\n' "$(du -h "$dir/$v.tar" | cut -f1)"
  done
  cp "$RUNTIME" "$dir/runtime.env"
  cp "$PARAMS" "$dir/params.env"
  { echo "NAME=$name"; echo "CREATED=$(date -Is)"; echo "CORE_HEIGHT=$ch"; echo "KNOTS_HEIGHT=$kh"
    echo "TIP_TIME=$tip"; } > "$dir/meta.env"
  echo "  saved to $dir"
}

# Stop the stack and refill the three volumes from a snapshot. Shared by `restore` and `arm`; it
# deliberately leaves the stack DOWN so the caller decides whether the miner comes back with it.
unpack_snapshot() {
  local name="$1"
  local dir="$SNAPDIR/$name" v
  [ -d "$dir" ] || { echo "no such snapshot: $name (see: bash scripts/regtest.sh snapshots)"; exit 1; }
  for v in $SNAP_VOLS; do
    [ -f "$dir/$v.tar" ] || { echo "snapshot '$name' is incomplete: missing $v.tar"; exit 1; }
  done

  echo "### restoring '$name' ###"
  dc down >/dev/null 2>&1 || true
  for v in $SNAP_VOLS; do
    printf '  unpacking %-12s' "$v"
    # Wipe and refill IN PLACE rather than `volume rm` + `create`: compose labels the volumes it
    # creates and refuses to adopt an identically-named one it did not make.
    docker run --rm -v "$(vol "$v"):/dst" -v "$dir:/in:ro" alpine \
      sh -c "find /dst -mindepth 1 -delete && tar -C /dst -xf /in/$v.tar"
    printf 'ok\n'
  done
  cp "$dir/runtime.env" "$RUNTIME"
}

# Warn when a snapshot's history ends well before now. Only meaningful for a plain `restore`, which
# hands the parked tip straight to the live miner; `arm` re-dates its catch-up blocks to end at now
# and so closes the gap itself.
stale_note() {
  local dir="$SNAPDIR/$1" tip age
  tip=$(grep -E '^TIP_TIME=' "$dir/meta.env" 2>/dev/null | cut -d= -f2- || echo 0)
  age=$(( $(date +%s) - ${tip:-0} ))
  if [ "${tip:-0}" -gt 0 ] && [ "$age" -gt 3600 ]; then
    echo
    echo "  NOTE: this snapshot's tip is dated $((age / 3600))h ago. The chain is correct, but the"
    echo "        next mined block will sit that far after its parent. Use 'arm' (which re-dates"
    echo "        its catch-up blocks to end at now), or re-run 'reset'."
  fi
}

cmd_restore() {
  local name="${1:-$DEFAULT_SNAP}"
  unpack_snapshot "$name"

  echo "### starting stack ###"
  dc up -d >/dev/null
  wait_healthy fw-core fw-knots

  # A restored chain's newest block is dated when the snapshot was TAKEN, but the miner resumes on
  # the real clock — so an old snapshot leaves one outsized gap between the parked tip and the first
  # live block. Harmless to the fork itself; it just makes measured spacing lie for one interval.
  stale_note "$name"
  cmd_status
}

# Restore, then walk the tip up to exactly N blocks below the fork before the miner ever runs.
#
# `restore` can only ever hand back the lead the snapshot was parked at (100), which at a 4s cadence
# is a ~7 minute wait for the split. This is the knob for "I want to watch the fork in 2 minutes"
# without paying for a reset: the nodes come up WITHOUT the miner, regtest_arm.py mines the gap at
# the configured spacing and hashrate ratio with its last block dated now, and only then does the
# miner start. Holding the miner back is the whole point — one live block mined on the real clock
# before the catch-up run would land 22h after its parent and pin the tip time in the wrong place.
cmd_arm() {
  local lead="${1:-$(param LEAD_BLOCKS)}" fork floor
  unpack_snapshot "$DEFAULT_SNAP"

  echo "### starting nodes + app (miner held back) ###"
  dc up -d --no-build core knots app >/dev/null
  wait_healthy fw-core fw-knots

  echo "### arming to $lead blocks below the fork ###"
  python3 "$HERE/scripts/regtest_arm.py" "$lead"

  # Let the app ingest the catch-up blocks before the miner adds more. TIP_MAX is 25 blocks per
  # poll, so a large lead takes a few polls; starting the miner into a half-ingested tip is what
  # makes the first spawn animation land on a block the chain has not drawn yet.
  fork=$(param FORK_AT_HEIGHT)
  wait_tip "$((fork - lead))"

  echo "### starting miner ###"
  dc up -d --no-build miner >/dev/null
  cmd_status
}

# Block until the app's /api/state reports the given tip height.
wait_tip() {
  local want="$1" got="" i
  printf '  waiting for the app to ingest up to %s' "$want"
  for i in $(seq 1 120); do
    got=$(curl -sf --max-time 5 http://localhost:8080/api/state 2>/dev/null \
          | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tip_height",""))' \
          2>/dev/null || true)
    [ "$got" = "$want" ] && { printf ' ok\n'; return 0; }
    printf '.'; sleep 1
  done
  printf '\n  WARNING: app tip is %s, expected %s; starting the miner anyway\n' "${got:-?}" "$want"
}

cmd_snapshots() {
  [ -d "$SNAPDIR" ] || { echo "no snapshots yet (bash scripts/regtest.sh snapshot [name])"; return; }
  printf '%-16s %-22s %-10s %-10s %s\n' NAME CREATED CORE KNOTS SIZE
  local d
  for d in "$SNAPDIR"/*/; do
    [ -d "$d" ] || continue
    local m="$d/meta.env"
    printf '%-16s %-22s %-10s %-10s %s\n' \
      "$(basename "$d")" \
      "$(grep -E '^CREATED=' "$m" 2>/dev/null | cut -d= -f2- || echo '?')" \
      "$(grep -E '^CORE_HEIGHT=' "$m" 2>/dev/null | cut -d= -f2- || echo '?')" \
      "$(grep -E '^KNOTS_HEIGHT=' "$m" 2>/dev/null | cut -d= -f2- || echo '?')" \
      "$(du -sh "$d" 2>/dev/null | cut -f1)"
  done
}

cmd_snapshot_rm() {
  local name="${1:?usage: snapshot-rm <name>}"
  local dir="$SNAPDIR/$name"
  case "$name" in */*|.|..) echo "bad snapshot name: $name"; exit 1;; esac
  [ -d "$dir" ] || { echo "no such snapshot: $name"; exit 1; }
  rm -rf "$dir"
  echo "removed snapshot '$name'"
}

cmd_reset() {
  # One-off overrides: any KEY=VALUE arg. They persist in the runtime file for later `up`s.
  : > "$RUNTIME"
  for kv in "$@"; do
    case "$kv" in
      *=*) put "$kv"; echo "[reset] override $kv";;
      *) echo "unknown argument: $kv (expected KEY=VALUE)"; exit 1;;
    esac
  done

  local lead spacing epochs retarget knots_per_100 fork_pin
  lead=$(param LEAD_BLOCKS);        spacing=$(param BLOCK_SPACING_SECS)
  epochs=$(param VISIBLE_EPOCHS);   retarget=$(param RETARGET_INTERVAL)
  knots_per_100=$(param KNOTS_PER_100)
  # Pinned fork height (mainnet's 961632), or 0 to derive one from where RDTS activation lands. Read
  # BEFORE the build writes the effective value back into $RUNTIME — `param` prefers $RUNTIME, so
  # reading it later would just echo whatever the last reset happened to produce.
  fork_pin=$(param FORK_AT_HEIGHT)

  echo "### wiping regtest chain + app db ###"
  dc down -v >/dev/null 2>&1 || true

  # Build every image UP FRONT. Building app/miner later would re-tag the node images too and
  # recreate fw-core/fw-knots mid-reset — restarting bitcoind under the chain we just built, which
  # among other things drops the loaded wallet holding the fork's funding coins.
  echo "### building images ###"
  dc build >/dev/null

  echo "### starting nodes ###"
  dc up -d --no-build core knots >/dev/null
  wait_healthy fw-core fw-knots

  if [ "${fork_pin:-0}" -gt 0 ] 2>/dev/null; then
    echo "### building chain to a pinned fork at $fork_pin (~$fork_pin blocks; this takes hours — it is snapshotted at the end) ###"
  else
    echo "### building chain (RDTS activation, then $((epochs * retarget)) blocks of mainnet-shaped history) ###"
  fi
  # regtest_build.py runs on the HOST and talks to the nodes over RPC, so — unlike the containers,
  # which dc() feeds compose/.env — it needs FW_RPC_USER/FW_RPC_PASS passed explicitly, or it falls
  # back to the compose defaults and can't authenticate ("nodes never became reachable").
  local rpc_user rpc_pass
  rpc_user=$(grep -E '^FW_RPC_USER=' "$MAIN_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  rpc_pass=$(grep -E '^FW_RPC_PASS=' "$MAIN_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  local out height fork floor
  out=$(BLOCK_SPACING_SECS="$spacing" LEAD_BLOCKS="$lead" VISIBLE_EPOCHS="$epochs" \
        RETARGET_INTERVAL="$retarget" KNOTS_PER_100="$knots_per_100" \
        FORK_AT_HEIGHT="${fork_pin:-0}" \
        RPC_USER="${rpc_user:-forkwars}" RPC_PASS="${rpc_pass:-forkwars_regtest}" \
        python3 "$HERE/scripts/regtest_build.py" | tee /dev/stderr)
  height=$(printf '%s' "$out" | grep -E '^HEIGHT=' | tail -1 | cut -d= -f2)
  fork=$(printf '%s' "$out" | grep -E '^FORK_AT_HEIGHT=' | tail -1 | cut -d= -f2)
  floor=$(printf '%s' "$out" | grep -E '^FLOOR_HEIGHT=' | tail -1 | cut -d= -f2)
  [ -n "$height" ] && [ -n "$fork" ] && [ -n "$floor" ] || { echo "chain build failed"; exit 1; }

  # The effective plan. With FORK_AT_HEIGHT pinned these just echo the request back; unpinned, the
  # fork lands wherever RDTS activation put it and this is the only record of where.
  put "FORK_AT_HEIGHT=$fork"
  put "FLOOR_HEIGHT=$floor"

  # The app first, ALONE. The miner would immediately start walking the LEAD_BLOCKS countdown, and
  # the snapshot below is only worth taking with the tip still parked where the build left it.
  echo "### starting app (miner held back so the tip stays parked at $height) ###"
  dc up -d --no-build app >/dev/null
  wait_backfill "$floor"

  if [ "${FW_SNAPSHOT:-1}" = "1" ]; then
    cmd_snapshot "$DEFAULT_SNAP"
  fi

  echo "### starting app + miner ###"
  dc up -d --no-build app miner >/dev/null

  cat <<EOF

====================================================================
 Regtest rebuilt as a full-scale mainnet mirror.   Open:  http://localhost:8080

   tip now         $height
   fork at         $fork   ($((fork - height)) blocks, ~$(( (fork - height) * spacing / 60 )) min at ${spacing}s/block)
   app floor       $floor   (visible window ${epochs} x ${retarget} blocks)
   knots hashrate  ${knots_per_100}%

 You never have to mine this again — the parked pre-fork chain is saved as '$DEFAULT_SNAP':

   bash scripts/regtest.sh restore        # back to the line above, in under a minute

 Watch:   docker logs -f fw-miner
 Status:  bash scripts/regtest.sh status
 Sooner:  bash scripts/regtest.sh fork-now
====================================================================
EOF
}

cmd_status() {
  local ch kh fork rdts invalid_at
  ch=$(C getblockcount); kh=$(K getblockcount)
  fork=$(param FORK_AT_HEIGHT)
  rdts=$(K getdeploymentinfo | python3 -c \
    "import sys,json;print(json.load(sys.stdin)['deployments']['reduced_data']['bip9']['status'])")
  # Height of the block Knots rejected, or empty. Deliberately NOT "is Core's *tip* invalid":
  # Knots never requests the descendants of a block it rejected, so once Core mines past the fork
  # its tip is simply absent from Knots' chaintips — the invalid entry stays pinned at the fork.
  invalid_at=$(K getchaintips | python3 -c \
    "import sys,json;t=[x['height'] for x in json.load(sys.stdin) if x['status']=='invalid'];print(min(t) if t else '')")

  echo "core height    $ch"
  echo "knots height   $kh"
  echo "rdts           $rdts"
  if [ -n "$invalid_at" ]; then
    echo "state          FORKED at $invalid_at (core is $((ch - kh)) ahead of knots)"
  else
    echo "state          agreed${fork:+, fork at $fork ($((fork - ch)) blocks to go)}"
  fi
  echo
  echo "params (compose/regtest.env + overrides):"
  for k in BLOCK_SPACING_SECS LEAD_BLOCKS VISIBLE_EPOCHS RETARGET_INTERVAL KNOTS_PER_100 \
           VIOLATION_BYTES FORK_AT_HEIGHT FLOOR_HEIGHT; do
    printf '  %-20s %s\n' "$k" "$(param "$k")"
  done
}

cmd_fork_now() {
  # Skip the countdown: point the miner's fork height at the current tip and restart it.
  local ch; ch=$(C getblockcount)
  put "FORK_AT_HEIGHT=$((ch + 1))"
  echo "[fork-now] tip $ch -> forking at $((ch + 1)); restarting miner + app"
  dc up -d app miner >/dev/null
  echo "[fork-now] done — the next Core block will be the violating one."
}

# Rebuild ONE service without disturbing the chain. `compose up --build app` is the trap this
# exists to avoid: it re-tags every image in the file, so the node images change too and compose
# recreates fw-core/fw-knots — restarting bitcoind mid-demo under the chain you are testing.
cmd_rebuild() {
  local svc="${1:-app}"
  echo "[rebuild] building $svc..."
  dc build "$svc" >/dev/null
  dc up -d --no-build --no-deps "$svc" >/dev/null
  echo "[rebuild] $svc restarted; nodes untouched."
}

case "${1:-help}" in
  reset)   shift; cmd_reset "$@";;
  arm)     cmd_arm "${2:-}";;
  rebuild) cmd_rebuild "${2:-app}";;
  status)  cmd_status;;
  fork-now) cmd_fork_now;;
  snapshot)    cmd_snapshot "${2:-$DEFAULT_SNAP}";;
  restore)     cmd_restore  "${2:-$DEFAULT_SNAP}";;
  snapshots)   cmd_snapshots;;
  snapshot-rm) cmd_snapshot_rm "${2:-}";;
  up)      shift; dc up -d --build "$@";;
  down)    dc down;;
  logs)    docker logs -f "${2:-fw-miner}";;
  params)  echo "# $PARAMS"; cat "$PARAMS"; echo; echo "# $RUNTIME (overrides)"; cat "$RUNTIME";;
  *) cat <<EOF
usage: bash scripts/regtest.sh <command>

  reset [KEY=VALUE ...]  wipe and rebuild the chain to compose/regtest.env (plus any overrides),
                         then save it as the '$DEFAULT_SNAP' snapshot. At the pinned mainnet fork
                         height this mines ~961,632 blocks and takes HOURS. Run it once.
  restore [name]         wipe and refill the volumes from a snapshot (default '$DEFAULT_SNAP') —
                         the fast way back to a parked pre-fork chain. Seconds, not hours.
                         Hands back the lead the snapshot was parked at (100 blocks).
  arm [N]                restore, then mine up to exactly N blocks below the fork before the miner
                         starts (default LEAD_BLOCKS=$(param LEAD_BLOCKS)). This is how you choose the
                         countdown you want to watch: N x BLOCK_SPACING_SECS seconds to the split.
  snapshot [name]        save the current chain + app db as a snapshot (stops the stack to do it)
  snapshots              list saved snapshots with heights and sizes
  snapshot-rm <name>     delete a snapshot
  rebuild [service]      rebuild one image (default app) and restart only it, leaving the chain up
  status                 heights, RDTS state, fork countdown, effective params
  fork-now               retarget the fork to the current tip and restart the miner
  up [service ...]       (re)start services with the current params
  down                   stop the stack (keeps the chain)
  logs [container]       follow a container's logs (default fw-miner)
  params                 print the parameter file and active overrides

the loop you actually want:
  bash scripts/regtest.sh reset          # once, hours — ends parked LEAD_BLOCKS short of the fork
  bash scripts/regtest.sh arm            # rewind and park LEAD_BLOCKS out; watch it count down
  bash scripts/regtest.sh arm 30         # ...or pick the countdown: 30 blocks = 2min at 4s/block
  bash scripts/regtest.sh fork-now       # or skip the wait entirely and split now

examples:
  bash scripts/regtest.sh reset
  bash scripts/regtest.sh reset LEAD_BLOCKS=20 MINE_INTERVAL_SECS=3
  bash scripts/regtest.sh reset FORK_AT_HEIGHT=0 VISIBLE_EPOCHS=2   # quick throwaway chain
  FW_SNAPSHOT=0 bash scripts/regtest.sh reset                       # skip the auto-snapshot
  bash scripts/regtest.sh snapshot forked                           # keep a post-fork state too
EOF
    exit 1;;
esac
