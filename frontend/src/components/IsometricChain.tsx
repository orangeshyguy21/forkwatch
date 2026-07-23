import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchViolations } from '../api';
import {
  ANCHOR,
  connectorColors,
  LANE_GAP,
  LINK_RX,
  LINK_RY,
  LINK_STEP,
  type BlockTheme,
  clamp,
  depthFor,
  focusAmount,
  focusLift,
  focusPop,
  heightLabel,
  MAX_SIZE,
  posP,
  sizeFor,
} from '../iso';
import { useScrollFocus } from '../hooks/useScrollFocus';
import { useStore } from '../store';
import type { Block, ViolationsResponse } from '../types';
import { cleanCoinbaseTag, clsx, formatBytes, formatInt, relativeTime, shortHash } from '../util';
import { EpochRail } from './EpochRail';
import { IsoBlock } from './IsoBlock';
import { ScrollRail } from './ScrollRail';
import { SIGNAL_LABEL, SignalStickerIcon, StickerIcon } from './ViolationStickers';

/** Fly-number reveal: how "flying" (0..1) it must be, and how long that must hold, before the big
 *  centered height number pops up — so a quick flick or a couple of notches doesn't flash it. */
const BIG_NUM_FLY_ON = 0.16;
const BIG_NUM_DEBOUNCE_MS = 320;

/** BIP-110/RDTS mandatory-signaling height: from this block on, non-signaling blocks are invalid
 *  (bit-4 signaling becomes required). RDTS then locks in / activates at 965,664. */
const MANDATORY_SIGNALING_HEIGHT = 961_632;

/** Chain-stretch pop: when a block lands in focus the neighbours recoil AWAY from it along the chain
 *  axis, then spring back — reading as the blockchain elastically stretching to admit the new focus,
 *  rather than the focused block itself squashing. Per-block recoil = distance-from-focus (blocks,
 *  capped) × unit px, damped by the block's own fisheye size so the compressed far tunnel doesn't
 *  fling apart or cross. */
const STRETCH_UNIT = 8;
const STRETCH_CAP = 6;

/** Width (px) of the block-details drawer (matches the inner panel's w-80). The drawer animates its
 *  width between 0 and this, so the chain smoothly reflows aside instead of snapping. */
const DRAWER_W = 320;

/** New-block spawn sequence, phase 1: the chain grows link-by-link over this long, then the block's
 *  base/cubes/panels follow (their delays live in IsoBlock and are timed to start after this). */
const CHAIN_BUILD_MS = 480;

interface Node {
  key: string;
  height: number;
  x: number;
  y: number;
  size: number;
  block?: Block;
  theme: BlockTheme;
  focusAmt: number;
  depth: number;
  z: number;
  materialize: boolean;
  showLabel: boolean;
}

interface ForkLabel {
  key: string;
  height: number;
  y: number;
  focusAmt: number;
  depth: number;
}

interface LanePt {
  x: number;
  y: number;
  size: number;
  h: number;
}

// Iso-cube anchor ratios (of block `size`), measured from the block's centre:
//  - BOT_VERTEX: the bottom-front corner (viewBox 50,116) the chain hangs FROM.
//  - TOP_FACE:   the centre of the top diamond (viewBox 50,25) the chain sockets INTO.
const BOT_VERTEX = 0.58;
const TOP_FACE = 0.33;

/** Full interlocking chain across ONE gap segment. Lives only in the gap — from the bottom vertex of
 *  the upper block to the top vertex of the lower one — so it emerges from the bottom and seats into
 *  the top, never crossing a block surface. Reserved for the focused block + the fork moment. */
function chainSegment(a: LanePt, b: LanePt, color: string, kp: string, build = false): JSX.Element[] {
  const upper = a.y <= b.y ? a : b;
  const lower = a.y <= b.y ? b : a;
  const x0 = upper.x;
  const y0 = upper.y + upper.size * BOT_VERTEX; // bottom-front corner of upper block
  const x1 = lower.x;
  const y1 = lower.y - lower.size * TOP_FACE; // centre of lower block's top face
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dy < 3) return []; // blocks touch/overlap -> no gap -> no chain
  const dist = Math.hypot(dx, dy) || 1;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const n = Math.max(1, Math.round(dist / LINK_STEP));
  const els: JSX.Element[] = [];
  for (let j = 0; j < n; j++) {
    const t = (j + 0.5) / n;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    const narrow = j % 2 === 1; // alternate flat / edge-on links => interlock
    // On a spawning block, the chain grows link-by-link from the EXISTING chain (lower, j=n-1) UP to
    // where the new block will assemble (upper, j=0), on a fixed total time regardless of gap size —
    // so it reliably finishes before the block's base draws. j=0 (block end) lands last.
    const linkDelay = build ? ((n - 1 - j) / Math.max(1, n - 1)) * CHAIN_BUILD_MS : 0;
    els.push(
      <ellipse
        key={`${kp}-${j}`}
        className={build ? 'fw-chain-link' : undefined}
        style={build ? { animationDelay: `${Math.round(linkDelay)}ms` } : undefined}
        cx={0}
        cy={0}
        rx={LINK_RX}
        ry={LINK_RY}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        transform={`translate(${cx.toFixed(1)},${cy.toFixed(1)}) rotate(${(ang + 90).toFixed(1)}) scale(${narrow ? 0.4 : 1},1)`}
      />,
    );
  }
  return els;
}

/** Simpler connector for every OTHER gap: a short tether confined to the gap (inset from both
 *  vertices) so it never slices through a translucent block face. */
function simpleConnector(a: LanePt, b: LanePt, color: string, kp: string): JSX.Element | null {
  const upper = a.y <= b.y ? a : b;
  const lower = a.y <= b.y ? b : a;
  const y0 = upper.y + upper.size * BOT_VERTEX;
  const y1 = lower.y - lower.size * TOP_FACE;
  const gap = y1 - y0;
  if (gap < 3) return null; // no gap -> blocks visually touch, nothing to draw
  const pad = Math.min(4, gap * 0.22);
  return (
    <line
      key={kp}
      x1={upper.x}
      y1={y0 + pad}
      x2={lower.x}
      y2={y1 - pad}
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
    />
  );
}

/** Draw a lane's connectors: the full interlocking chain only on the two gaps touching the focused
 *  block; the simpler tether everywhere else. */
function laneConnectors(
  pts: LanePt[],
  full: string,
  faint: string,
  kp: string,
  focusH: number,
  matH: number | null,
): JSX.Element[] {
  const els: JSX.Element[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // Height-based keys keep each link stable across the per-frame scroll re-renders, so the spawn
    // chain-build animation isn't remounted (and restarted) every frame.
    const k = `${kp}${a.h}_${b.h}`;
    if (a.h === focusH || b.h === focusH) {
      // The newer (upper) endpoint being the materializing tip => its downward chain builds on.
      els.push(...chainSegment(a, b, full, k, b.h === matH));
    } else {
      const c = simpleConnector(a, b, faint, k);
      if (c) els.push(c);
    }
  }
  return els;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function IsometricChain() {
  const state = useStore((s) => s.state);
  const initialized = useStore((s) => s.initialized);
  const tipHeight = useStore((s) => s.tipHeight);
  const pruneFloor = useStore((s) => s.pruneFloor);
  const blocksByHeight = useStore((s) => s.blocksByHeight);
  const knotsBlocksByHeight = useStore((s) => s.knotsBlocksByHeight);
  const fetchRange = useStore((s) => s.fetchRange);
  const fetchKnotsRange = useStore((s) => s.fetchKnotsRange);

  const reducedMotion = usePrefersReducedMotion();

  const initialFocus = useMemo<number | null>(() => {
    const p = new URLSearchParams(window.location.search).get('focus');
    if (!p || p === 'tip') return null;
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : null;
  }, []);

  const { scrollRef, focusHeight, target, zoom, velocity, atTip, setTarget, nudge } = useScrollFocus({
    tipHeight,
    pruneFloor,
    reducedMotion,
    initialFocus,
  });

  // Measure the chain viewport.
  const [dims, setDims] = useState({ w: 1200, h: 700 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [scrollRef]);

  // -------- New-block: follow tip + materialization --------
  const [materializeHeight, setMaterializeHeight] = useState<number | null>(null);
  const prevTip = useRef<number | null>(null);
  const matTimer = useRef<number | null>(null);
  useEffect(() => {
    const t = tipHeight;
    const prev = prevTip.current;
    prevTip.current = t;
    if (t == null || prev == null || t <= prev) return;
    if (atTip) setTarget(t, true);
    setMaterializeHeight(t);
    if (matTimer.current != null) window.clearTimeout(matTimer.current);
    matTimer.current = window.setTimeout(() => setMaterializeHeight(null), 3200);
  }, [tipHeight, atTip, setTarget]);
  useEffect(
    () => () => {
      if (matTimer.current != null) window.clearTimeout(matTimer.current);
    },
    [],
  );

  // -------- Focus-pop: stretch the REST of the chain away from the block that just landed --------
  const focusedHeight = Math.round(focusHeight);
  const [popHeight, setPopHeight] = useState<number | null>(null);
  const prevFocused = useRef(focusedHeight);
  const popTimer = useRef<number | null>(null);
  useEffect(() => {
    if (focusedHeight === prevFocused.current) return;
    prevFocused.current = focusedHeight;
    if (reducedMotion) return;
    setPopHeight(focusedHeight);
    if (popTimer.current != null) window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPopHeight(null), 380);
  }, [focusedHeight, reducedMotion]);
  useEffect(
    () => () => {
      if (popTimer.current != null) window.clearTimeout(popTimer.current);
    },
    [],
  );

  const forked = !!state && !state.agreed && !!state.fork;
  const forkAt = state?.fork?.at_height ?? Number.POSITIVE_INFINITY;
  const knotsTip = state?.knots?.blocks ?? null; // Knots minority chain tip height
  const knotsRejectsCoreTip = state?.fork?.knots_view_of_core_tip === 'invalid';

  const floor = pruneFloor ?? 0; // data floor: lowest height with cached block data
  const tip = tipHeight ?? 0;
  // Rail display floor: span the full configured window [floor_height, tip] so the epoch structure
  // renders even when the node has pruned down to a thin near-tip window. The chain view still uses
  // `floor` (data floor) for actual blocks; the rail shades [railFloor, floor) as not-yet-cached.
  const floorHeight = state?.floor_height ?? 0;
  const railFloor = floorHeight > 0 && floorHeight < floor ? floorHeight : floor;
  const H = dims.h;
  const W = dims.w;
  const anchorY = H * ANCHOR;
  // Centre the chain column in the viewport. The epoch rail (left) and timeline rail (right) are
  // the same width, so the viewport centre IS the page centre — the chain lines up under the clock.
  const baseX = W * 0.5;

  // Vertical window: a bounded band of CONSECUTIVE blocks centered on the focus (stride 1). The
  // fisheye tunnel shrinks distant blocks; we cap how many we mount and cull off-screen ones below.
  const HALF = 64;
  const heightHi = Math.min(tip, Math.floor(focusHeight) + HALF);
  const heightLo = Math.max(floor, Math.ceil(focusHeight) - HALF);

  const project = useCallback(
    (h: number) => {
      const d = h - focusHeight;
      return { d, y: anchorY - posP(d, zoom) - focusLift(d), size: sizeFor(d, zoom) * focusPop(d) };
    },
    [focusHeight, anchorY, zoom],
  );

  // Opacity fade near the top/bottom viewport edges, so blocks dissolve off-screen (not crowd).
  const edgeFade = useCallback(
    (y: number) => {
      const m = Math.min(170, H * 0.22);
      const smooth = (x: number) => x * x * (3 - 2 * x);
      return smooth(Math.min(clamp(y / m, 0, 1), clamp((H - y) / m, 0, 1)));
    },
    [H],
  );

  // -------- Build the visible node set --------
  const { nodes, spineArr, coreArr, knotsArr, junctionCore, junctionKnots, forkLabels } = useMemo(() => {
    const out: Node[] = [];
    const spine: LanePt[] = [];
    const core: LanePt[] = [];
    const knots: LanePt[] = [];
    let junctionCore: LanePt[] = [];
    let junctionKnots: LanePt[] = [];
    const labels: ForkLabel[] = [];
    const empty = { nodes: out, spineArr: spine, coreArr: core, knotsArr: knots, junctionCore, junctionKnots, forkLabels: labels };
    if (tipHeight == null || pruneFloor == null || heightHi < heightLo) {
      return empty;
    }

    const add = (
      h: number, x: number, y: number, size: number,
      block: Block | undefined, theme: BlockTheme, d: number, zBase: number, showLabel: boolean,
    ) => {
      out.push({
        key: `${theme}${h}`,
        height: h,
        x,
        y,
        size,
        block,
        theme,
        focusAmt: focusAmount(d),
        depth: depthFor(d) * edgeFade(y),
        z: Math.round(zBase - Math.abs(d) * 8),
        materialize: h === materializeHeight,
        showLabel,
      });
    };

    // Shared spine: heights at/below the fork point (or the whole window when not forked).
    const sharedTop = forked ? Math.min(heightHi, forkAt) : heightHi;
    for (let h = heightLo; h <= sharedTop; h++) {
      const p = project(h);
      if (p.y < -320 || p.y > H + 320 || p.size < 2) continue;
      add(h, baseX, p.y, p.size, blocksByHeight.get(h), 'shared', p.d, 2000, true);
      spine.push({ x: baseX, y: p.y, size: p.size, h });
    }

    if (forked) {
      // Two PARALLEL VERTICAL lanes at a constant offset (no fisheye on the offset, no rise), so both
      // chains run perfectly vertical. Same y for the same height => one shared row.
      // Core lane — from the range-fetched core chain (renders at any depth). Labels suppressed;
      // a single centered height label is drawn per row instead.
      for (let h = Math.max(heightLo, forkAt + 1); h <= heightHi; h++) {
        const p = project(h);
        if (p.y < -320 || p.y > H + 320 || p.size < 2) continue;
        add(h, baseX - LANE_GAP, p.y, p.size, blocksByHeight.get(h), 'core', p.d, 2100, false);
        core.push({ x: baseX - LANE_GAP, y: p.y, size: p.size, h });
        labels.push({ key: `L${h}`, height: h, y: p.y, focusAmt: focusAmount(p.d), depth: depthFor(p.d) * edgeFade(p.y) });
      }
      // Knots lane — from the Knots node's OWN chain (range-fetched, chain=knots), so the full
      // minority branch renders at any depth. It only exists up to the Knots tip (its 1% hashrate
      // means it crawls, so the lane is short and stops below the Core tip).
      const knotsHi = knotsTip == null ? heightHi : Math.min(heightHi, knotsTip);
      for (let hgt = Math.max(heightLo, forkAt + 1); hgt <= knotsHi; hgt++) {
        const p = project(hgt);
        if (p.y < -320 || p.y > H + 320 || p.size < 2) continue;
        add(hgt, baseX + LANE_GAP, p.y, p.size, knotsBlocksByHeight.get(hgt), 'knots', p.d, 2100, false);
        knots.push({ x: baseX + LANE_GAP, y: p.y, size: p.size, h: hgt });
      }
      // Y-junction: short connectors from the shared fork block up to each lane's first block —
      // ONLY when that region is on-screen (so we never draw a long diagonal to the distant tip).
      const pf = project(forkAt);
      const p1 = project(forkAt + 1);
      const onScreen = (y: number) => y >= -320 && y <= H + 320;
      if (forkAt >= heightLo && onScreen(pf.y) && onScreen(p1.y) && p1.size >= 6) {
        const fpPt: LanePt = { x: baseX, y: pf.y, size: pf.size, h: forkAt };
        junctionCore = [{ x: baseX - LANE_GAP, y: p1.y, size: p1.size, h: forkAt + 1 }, fpPt];
        if (knotsTip != null && forkAt + 1 <= knotsTip) {
          junctionKnots = [{ x: baseX + LANE_GAP, y: p1.y, size: p1.size, h: forkAt + 1 }, fpPt];
        }
      }
    }

    return { nodes: out, spineArr: spine, coreArr: core, knotsArr: knots, junctionCore, junctionKnots, forkLabels: labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    heightLo, heightHi, focusHeight, zoom, baseX, H, blocksByHeight, knotsBlocksByHeight, knotsTip,
    forked, forkAt, materializeHeight, project, state, tipHeight, pruneFloor, edgeFade,
  ]);

  // -------- Debounced data fetch (+ prefetch margin) --------
  const winLo = Math.floor(heightLo / 32);
  const winHi = Math.floor(heightHi / 32);
  // Focus-priority: load the focused block's data IMMEDIATELY (before the wider window), so nearby
  // blocks never delay the focus from filling in.
  const focusInt = Math.round(focusHeight);
  useEffect(() => {
    if (tipHeight == null) return;
    void fetchRange(focusInt - 2, focusInt + 2);
    if (forked && focusInt > forkAt) void fetchKnotsRange(focusInt - 2, focusInt + 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInt, tipHeight]);

  // Then fill the rest of the visible window (debounced).
  useEffect(() => {
    if (tipHeight == null) return;
    const t = setTimeout(() => {
      void fetchRange(heightLo - 48, heightHi + 48);
      if (forked) void fetchKnotsRange(Math.max(forkAt + 1, heightLo - 48), heightHi + 48);
    }, 90);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winLo, winHi, tipHeight, fetchRange, fetchKnotsRange, forked, forkAt]);

  // -------- Selection / drawer --------
  const initialSelected = useMemo(() => {
    const p = new URLSearchParams(window.location.search).get('open');
    const n = p ? parseInt(p, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }, []);
  const [selected, setSelected] = useState<number | null>(initialSelected);
  const drawerOpen = selected != null;
  // Keep showing the last block while the drawer animates CLOSED (selected → null). The persisted
  // height re-derives its blocks from the store, which still holds them during the collapse.
  const drawerHeightRef = useRef<number | null>(initialSelected);
  if (selected != null) drawerHeightRef.current = selected;
  const drawerHeight = drawerHeightRef.current;
  // At a forked height BOTH nodes have a (different) block — show each node's block.
  const selCore = drawerHeight != null ? blocksByHeight.get(drawerHeight) : undefined;
  const selKnots =
    drawerHeight != null && forked && drawerHeight > forkAt ? knotsBlocksByHeight.get(drawerHeight) : undefined;
  const onSelect = useCallback(
    (h: number) => {
      setSelected(h);
      setTarget(h, true);
    },
    [setTarget],
  );

  // -------- Keyboard -------- (window-level so arrows scroll the chain without needing to click it
  // first; ignored while typing in a field). ↑/↓ step one block, PgUp/PgDn ten, Home/End jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tipHeight == null || pruneFloor == null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      switch (e.key) {
        case 'ArrowUp':
          nudge(1);
          break;
        case 'ArrowDown':
          nudge(-1);
          break;
        case 'PageUp':
          nudge(10);
          break;
        case 'PageDown':
          nudge(-10);
          break;
        case 'Home':
          setTarget(tipHeight, true);
          break;
        case 'End':
          setTarget(pruneFloor, true);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tipHeight, pruneFloor, nudge, setTarget]);

  const bigNum = Math.round(focusHeight);
  const flyAmt = clamp((zoom - 1) / 1.3, 0, 1);
  const notReady = !initialized || tipHeight == null || pruneFloor == null;

  // Debounce the big fly-number: only reveal it once the flight has been sustained past
  // BIG_NUM_DEBOUNCE_MS (a quick flick won't flash it), and hide it the moment flying stops.
  const flying = flyAmt > BIG_NUM_FLY_ON;
  const [bigNumOn, setBigNumOn] = useState(false);
  const bigNumTimer = useRef<number | null>(null);
  useEffect(() => {
    if (flying) {
      bigNumTimer.current = window.setTimeout(() => setBigNumOn(true), BIG_NUM_DEBOUNCE_MS);
      return () => {
        if (bigNumTimer.current != null) window.clearTimeout(bigNumTimer.current);
      };
    }
    setBigNumOn(false);
    return undefined;
  }, [flying]);

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* Left rail: the current epoch zoomed — signaling tally, per-block signal markers, and a
          seek scoped to this epoch. Same width as the right rail, which centres the chain. */}
      {!notReady && state && (
        <EpochRail
          tip={tip}
          dataFloor={floor}
          focus={target}
          signaling={state.signaling}
          forkHeight={forked ? forkAt : null}
          onSeek={(h) => setTarget(h, true)}
        />
      )}

      {/* Details panel PUSHES the chain aside (in-flow). Its width animates 0↔DRAWER_W so the whole
          view reflows smoothly; the inner panel keeps a fixed width and is revealed/clipped. */}
      <div
        className="h-full shrink-0 overflow-hidden"
        style={{
          width: drawerOpen ? DRAWER_W : 0,
          transition: reducedMotion ? undefined : 'width 300ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        }}
        aria-hidden={!drawerOpen}
      >
        {drawerHeight != null && (
          <BlockDrawer height={drawerHeight} coreBlock={selCore} knotsBlock={selKnots} onClose={() => setSelected(null)} />
        )}
      </div>
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-hidden outline-none"
        tabIndex={0}
        role="application"
        aria-label="Isometric block chain"
      >
        {notReady && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-sm text-zinc-500">
              {state ? 'Building the chain…' : 'Connecting to nodes…'}
            </div>
          </div>
        )}

        {/* connector: faint base line + a real chain of interlocking links */}
        {nodes.length > 0 && (
          <svg
            className="pointer-events-none absolute inset-0"
            width={W}
            height={H}
            style={{ overflow: 'visible', zIndex: 2400 }}
          >
            {laneConnectors(spineArr, connectorColors.standard[0], connectorColors.standard[1], 's', focusInt, materializeHeight)}
            {laneConnectors(coreArr, connectorColors.standard[0], connectorColors.standard[1], 'c', focusInt, materializeHeight)}
            {laneConnectors(knotsArr, connectorColors.orphan[0], connectorColors.orphan[1], 'k', focusInt, materializeHeight)}
            {junctionCore.length === 2 && chainSegment(junctionCore[0], junctionCore[1], connectorColors.standardJunction, 'jc')}
            {junctionKnots.length === 2 && chainSegment(junctionKnots[0], junctionKnots[1], connectorColors.orphanJunction, 'jk')}
          </svg>
        )}

        {/* blocks */}
        {nodes.map((n) => {
          // Recoil = signed distance from the just-landed focus, capped and damped by the block's own
          // fisheye size. Higher-height blocks (above, smaller screen-y) push up; lower ones push down.
          let stretchDy = 0;
          if (popHeight != null && n.height !== popHeight) {
            const dd = n.height - popHeight;
            const mag = Math.min(Math.abs(dd), STRETCH_CAP) * STRETCH_UNIT * Math.min(1, n.size / MAX_SIZE);
            stretchDy = -Math.sign(dd) * mag;
          }
          return (
          <div
            key={n.key}
            className="absolute"
            style={{ left: n.x, top: n.y, transform: 'translate(-50%, -50%)', zIndex: n.z }}
          >
            <IsoBlock
              height={n.height}
              size={n.size}
              block={n.block}
              theme={n.theme}
              focusAmt={n.focusAmt}
              depth={n.depth}
              reducedMotion={reducedMotion}
              selected={selected === n.height}
              materialize={n.materialize}
              stretchDy={stretchDy}
              showLabel={n.showLabel}
              onSelect={onSelect}
            />
          </div>
          );
        })}

        {/* single shared height label per fork row (centered between the two lanes) */}
        {forkLabels.map((l) => (
          <div
            key={l.key}
            className="pointer-events-none absolute font-mono font-semibold tabular-nums text-zinc-100"
            style={{
              left: baseX,
              top: l.y,
              transform: 'translate(-50%, -50%)',
              opacity: l.depth,
              fontSize: Math.max(11, 12 + l.focusAmt * 20),
              textShadow: '0 1px 5px rgba(0,0,0,0.95)',
              zIndex: 3000,
            }}
          >
            {heightLabel(l.height)}
          </div>
        ))}

        {/* big height overlay while flying — sits to the RIGHT of the focused block (not over it),
            vertically centered on it. Revealed only after the debounce (bigNumOn), faded in/out. */}
        {flyAmt > 0.02 && !reducedMotion && (
          <div
            className="pointer-events-none absolute"
            style={{ left: baseX + 148, top: anchorY, transform: 'translateY(-50%)' }}
          >
            <div
              className="font-mono font-black tabular-nums text-white"
              style={{
                transformOrigin: 'left center',
                transform: `scale(${1 + flyAmt * 1.5})`,
                opacity: bigNumOn ? 0.45 + flyAmt * 0.5 : 0,
                transition: 'opacity 160ms ease-out',
                fontSize: 44,
                textShadow: '0 4px 30px rgba(0,0,0,0.95)',
              }}
            >
              {heightLabel(bigNum)}
            </div>
          </div>
        )}

        {/* HUD */}
        {!notReady && (
          <div className="pointer-events-none absolute right-4 top-4 flex flex-col items-end gap-1.5">
            {(() => {
              // Countdown to BIP-110 mandatory signaling, driven by the live chain tip. Once the tip
              // reaches the threshold, flip to a "reached" state instead of showing a negative count.
              const toMandatory = MANDATORY_SIGNALING_HEIGHT - tip;
              const reached = toMandatory <= 0;
              return (
                <div
                  className={clsx(
                    'rounded-md border px-2.5 py-1 font-mono text-[11px] backdrop-blur',
                    reached
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
                  )}
                  title={`Mandatory signaling at block ${formatInt(MANDATORY_SIGNALING_HEIGHT)}`}
                >
                  {reached
                    ? '● mandatory signaling live'
                    : `${formatInt(toMandatory)} block${toMandatory === 1 ? '' : 's'} → mandatory signaling`}
                </div>
              );
            })()}
            <div className="rounded-md border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[11px] text-zinc-400 backdrop-blur">
              focus {heightLabel(bigNum)}
            </div>
            <div
              className={clsx(
                'rounded-md border px-2.5 py-1 font-mono text-[11px] backdrop-blur',
                atTip
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/10 bg-black/50 text-zinc-500',
              )}
            >
              {atTip ? '● following tip' : `${formatInt(Math.max(0, tip - bigNum))} below tip`}
            </div>
            {Math.abs(velocity) > 0.15 && (
              <div className="rounded-md border border-white/10 bg-black/50 px-2.5 py-1 font-mono text-[10px] text-zinc-500 backdrop-blur">
                zoom {zoom.toFixed(1)}×
              </div>
            )}
          </div>
        )}

        {/* fork banner */}
        {forked && (
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-red-300 backdrop-blur">
            ⚔ Forked at #{formatInt(forkAt)}
            {knotsRejectsCoreTip && <span className="ml-2 text-red-200/80">Knots rejects Core →</span>}
          </div>
        )}
      </div>

      {!notReady && (
        <ScrollRail
          tip={tip}
          floor={railFloor}
          dataFloor={floor}
          focus={target}
          forkHeight={forked ? forkAt : null}
          onSeek={(h) => setTarget(h, true)}
          onTip={() => setTarget(tip, true)}
          onFork={() => setTarget(forkAt, true)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Drawer: block details + on-demand violations for non-pass verdicts.
// --------------------------------------------------------------------------

function BlockDrawer({
  height,
  coreBlock,
  knotsBlock,
  onClose,
}: {
  height: number;
  coreBlock?: Block;
  knotsBlock?: Block;
  onClose: () => void;
}) {
  // Same block on both chains (below the fork, or not forked) => a single "shared" section.
  const shared = !!coreBlock && !!knotsBlock && coreBlock.hash === knotsBlock.hash;
  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-white/10 bg-black/70 backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="font-mono text-sm font-bold text-zinc-100">block {heightLabel(height)}</div>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          ✕ close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!coreBlock && !knotsBlock && (
          <div className="px-4 py-4 text-sm text-zinc-500">Block data still loading for this height…</div>
        )}
        {shared && coreBlock && <BlockSection side="shared" block={coreBlock} />}
        {!shared && coreBlock && <BlockSection side="core" block={coreBlock} />}
        {!shared && knotsBlock && <BlockSection side="knots" block={knotsBlock} />}
      </div>
    </div>
  );
}

// One node's block at the selected height (its own hash, verdict, violations).
function BlockSection({ side, block }: { side: 'core' | 'knots' | 'shared'; block: Block }) {
  const [violations, setViolations] = useState<ViolationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsViolations = block.rdts_verdict !== 'pass' && block.rdts_verdict !== 'unscanned';

  useEffect(() => {
    if (!needsViolations) {
      setViolations(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setErr(null);
    fetchViolations(block.hash, ctrl.signal)
      .then((v) => setViolations(v))
      .catch((e) => {
        if (!ctrl.signal.aborted) setErr((e as Error).message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [block.hash, needsViolations]);

  // Chip mirrors the top panel's state language, colour-coded to the chain viz: agreement is green
  // (as the header's "In Agreement" indicator), the canonical/winning lane wears the standard-chain
  // blue, and the losing branch wears the orphan's steel-grey. The node client name rides along
  // muted so we don't lose which node reported the block.
  const chip =
    side === 'shared'
      ? { label: 'In agreement', node: null, cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }
      : side === 'core'
        ? { label: 'Biggest chain', node: 'Bitcoin Core', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200' }
        : { label: 'Orphaned chain', node: 'Bitcoin Knots', cls: 'border-slate-400/40 bg-slate-400/10 text-slate-300' };

  return (
    <div className="border-b border-white/10 px-4 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className={clsx('inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', chip.cls)}>
          {chip.label}
        </span>
        {chip.node && (
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">{chip.node}</span>
        )}
      </div>
      <div className="space-y-2 text-sm">
        <Row label="hash" value={shortHash(block.hash)} mono />
        <Row label="time" value={relativeTime(block.time)} />
        <Row
          label="mined by"
          value={block.miner ?? (block.coinbase_tag ? 'unknown pool' : '—')}
        />
        <Row label="tx count" value={formatInt(block.tx_count)} />
        <Row label="size" value={formatBytes(block.size)} />
        <Row label="weight" value={formatInt(block.weight)} />
        <Row label="version" value={`0x${block.version.toString(16)}`} mono />
        <Row label="RDTS verdict" value={block.rdts_verdict} mono />
      </div>

      {/* Coinbase tag (the ASCII the miner stamped into the coinbase) — trailing binary noise
          trimmed for readability; the untouched string is available on hover. */}
      {block.coinbase_tag && cleanCoinbaseTag(block.coinbase_tag) && (
        <div className="mt-2.5">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">coinbase tag</div>
          <div
            title={block.coinbase_tag}
            className="max-h-16 overflow-y-auto break-all rounded border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10.5px] leading-snug text-zinc-400"
          >
            {cleanCoinbaseTag(block.coinbase_tag)}
          </div>
        </div>
      )}

      {/* Signaling badge — the counterpart to the violations panel below, and the sidebar echo of
          the sticker on the block's flank. Its presence IS the answer, so the old yes/no row is
          gone: a non-signaling block simply has no badge, exactly as a clean block has no
          violations panel. */}
      {block.signals_110 && (
        <div className="mt-3 flex items-center gap-2.5 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-2">
          <div className="shrink-0">
            <SignalStickerIcon size={26} />
          </div>
          <div className="min-w-0">
            <div className="text-[11.5px] font-semibold text-emerald-200">Signals BIP-110</div>
            <div className="text-[10.5px] text-zinc-500" title={SIGNAL_LABEL}>
              bit 4 set in the block version
            </div>
          </div>
        </div>
      )}

      {needsViolations && (
        <div className="mt-3 rounded-md border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-amber-300">RDTS violations</div>
          {loading && <div className="text-xs text-zinc-500">Scanning…</div>}
          {err && <div className="text-xs text-red-400">{err}</div>}
          {violations && violations.violations.length === 0 && !loading && (
            <div className="text-xs text-zinc-500">None found.</div>
          )}
          <div className="space-y-1.5">
            {violations?.violations.map((v, i) => (
              <div
                key={i}
                className="flex items-center gap-2.5 rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5"
              >
                <div className="shrink-0">
                  <StickerIcon rule={v.rule} size={26} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-semibold text-amber-200">{v.kind}</div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">rule {v.rule}</div>
                </div>
                <div className="shrink-0 font-mono text-sm font-bold tabular-nums text-amber-300">
                  ×{formatInt(v.count)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5">
      <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={clsx('text-right text-zinc-200', mono && 'font-mono text-[12px]')}>{value}</span>
    </div>
  );
}
