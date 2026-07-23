import { memo, useEffect, useMemo, useRef } from 'react';
import {
  CUBE_ASPECT,
  CUBE_FACES,
  CUBE_VIEWBOX,
  type BlockTheme,
  fullness,
  heightLabel,
  themeColors,
} from '../iso';
import type { Block } from '../types';
import { clsx, formatBytes, formatInt, shortHash } from '../util';
import { SIGNAL_LABEL, SIGNAL_STICKER_BODY, ViolationStickers } from './ViolationStickers';

interface Props {
  height: number;
  size: number; // iso footprint width in px
  block?: Block;
  theme: BlockTheme;
  focusAmt: number; // 0..1 detail reveal
  depth: number; // 0..1 opacity / atmospheric
  reducedMotion: boolean;
  selected: boolean;
  /** When true, run the "build from falling pieces" spawn animation. */
  materialize?: boolean;
  /** Signed px this block should recoil along the chain axis when a new block lands in focus — the
   *  "chain stretches" pop. The focused block itself gets 0 (it stays put); neighbours spring out
   *  away from the focus and settle back. */
  stretchDy?: number;
  /** Show the block's own height tick (suppressed in fork mode for a single centered label). */
  showLabel?: boolean;
  onSelect: (height: number) => void;
}

const RDTS_TAG: Record<string, { label: string; cls: string }> = {
  would_violate: { label: 'WOULD VIOLATE', cls: 'text-amber-300 border-amber-400/60 bg-amber-500/10' },
  invalid: { label: 'REJECTED BY KNOTS', cls: 'text-red-300 border-red-400/60 bg-red-500/10' },
};

// Spawn geometry. The big cube is diced into an N×N×N grid of small iso-cubes — one per transaction
// The block assembles from a fine N×N×N micro-cube grid, but we only rain the visible shell of the
// FILLED region — the bottom `fullness` fraction of the cube. So the pile literally rises to the
// block's fill level: an empty block builds a thin slab, a full block a tall stack. Then the three
// big face panels slide in to enclose it. N is ~2× the old grid for a much finer, denser grain.
// Voxel axes from the cube's front-top corner (50,50): u→right, v→left, w→down.
const VOX_N = 38; // grid resolution per axis (density); a full block ≈ 3·N² cubes (~10× the old grid)
// Hard cap on rendered cubes; N steps down until the shell fits. The cubes are drawn on a canvas
// overlay (VoxelRain below) — thousands of individually CSS-animated SVG polygons under the block's
// drop-shadow filter re-rasterized every frame and made the spawn stutter, while the canvas repaints
// only the cubes currently in flight. Low-end devices (few cores / little RAM) get a lighter shower
// of bigger cubes.
const VOX_MAX_COUNT = 3200;
const VOX_MAX_COUNT_LOW = 1500;
const VOX_BUDGET =
  typeof navigator !== 'undefined' &&
  ((navigator.hardwareConcurrency || 8) <= 4 ||
    ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4)
    ? VOX_MAX_COUNT_LOW
    : VOX_MAX_COUNT;

// Canvas overrun beyond the cube viewBox (viewBox units), so scattered cubes can fall in from above
// and beside the block without clipping. Sized to the max |vx| / |vy| scatter below.
const VOX_PAD_X = 26;
const VOX_PAD_TOP = 136;
const VOX_PAD_BOT = 6;
const VOX_FALL_MS = 420; // per-cube flight time (matches the old fwVoxelFall duration)

// New-block spawn timeline (ms from materialize). Phase 1 (chain grows link-by-link, ~480ms) lives in
// IsometricChain; the block's own phases follow it: 2) the base diamond draws, 3) the cubes rain in,
// 4) the panels close over them. Each starts after the previous is under way.
const SPAWN_BASE_AT = 700; // base diamond starts drawing (after the chain has reached the block)
const SPAWN_VOX_T0 = 980; // first cubes begin to fall
const SPAWN_VOX_PERIOD = 1000; // spread of the cube fall
const SPAWN_ENCLOSE = 2350; // panels slide in to seal, once the cubes have mostly landed
const SPAWN_BASE = [
  [50, 66],
  [100, 91],
  [50, 116],
  [0, 91],
];
const SEAM = 'rgba(148,196,180,0.26)';
const poly = (a: number[][]) => a.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

// Vertical extent of the cube body at the near corner (y=50 top rim → y=116 base).
const BODY_H = 66;
// Front silhouette of the body (both flanks), used to clip the rising contents so nothing spills past
// the base while the "pour" animation plays.
const BODY_HEX = '0,25 50,50 100,25 100,91 50,116 0,91';

// Face bases for markers painted flat onto a flank, as (u,v) in [0,1]^2 → viewBox coords:
//  left face:  origin (0,25),   u-axis (50,25),  v-axis (0,66)  -> matrix(50,25,0,66,0,25)
//  right face: origin (100,25), u-axis (-50,25), v-axis (0,66)  -> matrix(-50,25,0,66,100,25)

// Signaling sticker footprint on the left face, in that face's (u,v) units. Chosen so the artwork
// reads square: the u-axis is 55.9 viewBox units long and the v-axis 66, so u·55.9 ≈ v·66. Sized
// ~25% over the old chevron marker's box because the die-cut border insets the coloured shape to
// 75% of the footprint (rect 8→56 of 64), which would otherwise shrink the visible mark.
const SIGNAL_U = 0.5;
const SIGNAL_V = 0.42;

interface VoxCell {
  top: number[] | null; // top-face quad, flattened [x0,y0 … x3,y3] (viewBox units); null on flank cells
  left: number[];
  right: number[];
  cx: number; // cell centre — the scale origin for the landing squash
  cy: number;
  delay: number; // ms from materialize
  vx: number; // scatter start offset (viewBox units)
  vy: number;
  d: number; // painter depth: larger = farther from viewer (drawn first)
}

/** The spawn's cube-rain, drawn on a small 2D canvas instead of thousands of animated SVG nodes.
 *  Landed cubes are stamped once onto an offscreen "settled" layer, so each frame costs one
 *  drawImage plus only the cubes currently in flight; seams are stroked only on landing. The bitmap
 *  resolution is fixed at mount while the CSS box tracks `size`, so the focus glide rescales the
 *  canvas on the compositor instead of restarting the animation. */
function VoxelRain({
  cells,
  size,
  colors,
}: {
  cells: VoxCell[];
  size: number;
  colors: { top: string; left: string; right: string };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Live values the rAF loop reads without retriggering the effect (their identity changes per render).
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || cells.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.max(0.2, sizeRef.current / 100) * dpr; // device px per viewBox unit
    const W = Math.max(1, Math.round((100 + VOX_PAD_X * 2) * k));
    const H = Math.max(1, Math.round((116 + VOX_PAD_TOP + VOX_PAD_BOT) * k));
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const settled = document.createElement('canvas');
    settled.width = W;
    settled.height = H;
    const sctx = settled.getContext('2d');
    if (!ctx || !sctx) return;
    sctx.setTransform(k, 0, 0, k, VOX_PAD_X * k, VOX_PAD_TOP * k);

    // Append one quad to the current path under a uniform scale+translate (no ctx.save/scale — the
    // affine is done in JS so thousands of quads can share a single fill call).
    const quadTo = (c2: CanvasRenderingContext2D, q: number[], sc: number, tx: number, ty: number) => {
      c2.moveTo(q[0] * sc + tx, q[1] * sc + ty);
      c2.lineTo(q[2] * sc + tx, q[3] * sc + ty);
      c2.lineTo(q[4] * sc + tx, q[5] * sc + ty);
      c2.lineTo(q[6] * sc + tx, q[7] * sc + ty);
      c2.closePath();
    };
    const fillQuad = (c2: CanvasRenderingContext2D, q: number[], fill: string, sc: number, tx: number, ty: number, seam: boolean) => {
      c2.beginPath();
      quadTo(c2, q, sc, tx, ty);
      c2.fillStyle = fill;
      c2.fill();
      if (seam) {
        c2.strokeStyle = SEAM;
        c2.lineWidth = 0.18;
        c2.stroke();
      }
    };
    const drawCell = (c2: CanvasRenderingContext2D, cell: VoxCell, seam: boolean) => {
      const col = colorsRef.current;
      fillQuad(c2, cell.left, col.left, 1, 0, 0, seam);
      fillQuad(c2, cell.right, col.right, 1, 0, 0, seam);
      if (cell.top) fillQuad(c2, cell.top, col.top, 1, 0, 0, seam);
    };

    const landed = new Uint8Array(cells.length);
    // Per-frame motion scratch (affine per in-flight cell: X' = x·sc + tx, Y' = y·sc + ty). Opaque
    // in-flight cells are drawn as ONE batched path per face colour — three fillStyle changes per
    // frame instead of three per cube, which is what weak rasterizers choke on. Cells still fading
    // in (first 28% of flight) keep per-cell alpha and are drawn individually.
    const mSc = new Float64Array(cells.length);
    const mTx = new Float64Array(cells.length);
    const mTy = new Float64Array(cells.length);
    const opaque = new Int32Array(cells.length);
    const fadingIn = new Int32Array(cells.length);
    const easeOut = (x: number) => 1 - (1 - x) ** 3;
    const FADE_AT = SPAWN_ENCLOSE + 240; // matches the base diamond's fw-spawn-out timing
    const FADE_MS = 260;
    const t0 = performance.now();
    let raf = 0;

    const frame = () => {
      const t = performance.now() - t0;
      const fade = t < FADE_AT ? 1 : Math.max(0, 1 - (t - FADE_AT) / FADE_MS);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (fade <= 0) return; // panels sealed + rain faded: done, leave the canvas clear
      ctx.globalAlpha = fade;
      ctx.drawImage(settled, 0, 0);
      ctx.setTransform(k, 0, 0, k, VOX_PAD_X * k, VOX_PAD_TOP * k);
      let nOpaque = 0;
      let nFading = 0;
      for (let i = 0; i < cells.length; i++) {
        if (landed[i]) continue;
        const cell = cells[i];
        const p = (t - cell.delay) / VOX_FALL_MS;
        if (p <= 0) continue;
        if (p >= 1) {
          landed[i] = 1;
          drawCell(sctx, cell, true); // stamp at rest onto the settled layer (already blitted this frame)
          ctx.globalAlpha = fade;
          drawCell(ctx, cell, true);
          continue;
        }
        // Keyframes ported from the old fwVoxelFall CSS: fall in from the scatter offset while
        // fading + growing, overshoot 3px past rest, spring back.
        let px: number, py: number, sc: number;
        if (p < 0.8) {
          const q = easeOut(p / 0.8);
          px = cell.vx * (1 - q);
          py = cell.vy * (1 - q) + 3 * q;
          sc = 0.4 + 0.64 * q;
        } else if (p < 0.92) {
          const q = (p - 0.8) / 0.12;
          px = 0;
          py = 3 - 3.5 * q;
          sc = 1.04 - 0.05 * q;
        } else {
          const q = (p - 0.92) / 0.08;
          px = 0;
          py = -0.5 + 0.5 * q;
          sc = 0.99 + 0.01 * q;
        }
        mSc[i] = sc;
        mTx[i] = cell.cx * (1 - sc) + px;
        mTy[i] = cell.cy * (1 - sc) + py;
        if (p < 0.28) fadingIn[nFading++] = i;
        else opaque[nOpaque++] = i;
      }
      // Batched opaque in-flight cells: one path + fill per face colour. Seams are skipped in
      // flight (invisible while moving) and painter order between airborne cubes doesn't matter —
      // they're scattered mid-air.
      if (nOpaque > 0) {
        const col = colorsRef.current;
        ctx.globalAlpha = fade;
        ctx.beginPath();
        for (let j = 0; j < nOpaque; j++) {
          const i = opaque[j];
          quadTo(ctx, cells[i].left, mSc[i], mTx[i], mTy[i]);
        }
        ctx.fillStyle = col.left;
        ctx.fill();
        ctx.beginPath();
        for (let j = 0; j < nOpaque; j++) {
          const i = opaque[j];
          quadTo(ctx, cells[i].right, mSc[i], mTx[i], mTy[i]);
        }
        ctx.fillStyle = col.right;
        ctx.fill();
        ctx.beginPath();
        for (let j = 0; j < nOpaque; j++) {
          const i = opaque[j];
          const top = cells[i].top;
          if (top) quadTo(ctx, top, mSc[i], mTx[i], mTy[i]);
        }
        ctx.fillStyle = col.top;
        ctx.fill();
      }
      for (let j = 0; j < nFading; j++) {
        const i = fadingIn[j];
        const cell = cells[i];
        const col = colorsRef.current;
        ctx.globalAlpha = fade * (((t - cell.delay) / VOX_FALL_MS) / 0.28);
        fillQuad(ctx, cell.left, col.left, mSc[i], mTx[i], mTy[i], false);
        fillQuad(ctx, cell.right, col.right, mSc[i], mTx[i], mTy[i], false);
        if (cell.top) fillQuad(ctx, cell.top, col.top, mSc[i], mTx[i], mTy[i], false);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // Geometry (cells) is the only real input; size/colors are read via refs each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells]);

  const s = size / 100;
  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: 'absolute',
        left: -VOX_PAD_X * s,
        top: -VOX_PAD_TOP * s,
        width: (100 + VOX_PAD_X * 2) * s,
        height: (116 + VOX_PAD_TOP + VOX_PAD_BOT) * s,
        pointerEvents: 'none',
      }}
    />
  );
}

function IsoBlockImpl({
  height,
  size,
  block,
  theme,
  focusAmt,
  depth,
  reducedMotion,
  selected,
  materialize = false,
  stretchDy = 0,
  showLabel = true,
  onSelect,
}: Props) {
  const loading = !block;
  const c = themeColors(theme, block?.rdts_verdict, loading);
  const w = size;
  const h = size * CUBE_ASPECT;
  const showDetail = focusAmt > 0.5 && !loading;
  const gid = `g-${theme}-${loading ? 'l' : 'f'}`;
  const animate = materialize && !reducedMotion && !loading;
  const labelSize = Math.max(10, Math.min(30, size * 0.16));


  // Mempool-style fullness: the vivid "contents" fill the shell from the base up to a waterline whose
  // height = the block's weight/tx fullness. d = how far the surface sits below the cube's top rim.
  const fill = c.fill;
  const fillFrac = fill ? fullness(block) : 0;
  const d = (1 - fillFrac) * BODY_H; // waterline drop from the top rim (px, viewBox units)
  const wl = 25 + d; // y of the waterline where it meets the outer (0 / 100) verticals
  const wlFront = 50 + d; // y of the waterline at the near (x=50) corner
  const fillLeft = `0,${wl} 50,${wlFront} 50,116 0,91`;
  const fillRight = `50,${wlFront} 100,${wl} 100,91 50,116`;
  // The visible surface line is a downward chevron meeting at the near corner.
  const waterPath = `M0,${wl.toFixed(2)} L50,${wlFront.toFixed(2)} L100,${wl.toFixed(2)}`;
  // Spawn "pour": the contents start pushed fully below the base (rise = fill height) and rise into place.
  const riseStyle = { '--rise': `${(fillFrac * BODY_H).toFixed(1)}px`, animationDelay: `${SPAWN_ENCLOSE}ms` } as React.CSSProperties;

  const glow = c.glow;
  const filter = glow
    ? `drop-shadow(0 0 ${Math.round(size * 0.09)}px ${glow})`
    : `drop-shadow(0 ${Math.round(size * 0.06)}px ${Math.round(size * 0.09)}px rgba(0,0,0,0.55))`;

  // New-block spawn: the visible shell of the FILLED region of an N³ voxel grid. The pile only rises
  // to the block's fullness (bottom `fillRows` of N layers), so the assembly height mirrors how full
  // the block is; each micro-cube rains in scattered (randomized offset + delay). Back-to-front.
  const voxels = useMemo<VoxCell[]>(() => {
    if (!animate) return [];
    const f = fullness(block);
    // Shell of the filled region ≈ N² (waterline surface) + 2·N·fillRows (the two front flanks).
    // Step N down until that stays under the device's perf budget.
    const rowsFor = (n: number) => Math.max(1, Math.round(f * n));
    const shellCount = (n: number) => n * n + 2 * n * rowsFor(n);
    let N = VOX_N;
    while (N > 6 && shellCount(N) > VOX_BUDGET) N -= 2;
    const fillRows = rowsFor(N);
    const kTop = N - fillRows; // waterline layer (flat top of the pile)
    const u: [number, number] = [50 / N, -25 / N]; // →right
    const v: [number, number] = [-50 / N, -25 / N]; // →left
    const w: [number, number] = [0, 66 / N]; // →down
    const Tf: [number, number] = [50, 50]; // cube front-top corner
    const quad = (px: number, py: number, A: [number, number], B: [number, number]) => [
      px, py, px + A[0], py + A[1], px + A[0] + B[0], py + A[1] + B[1], px + B[0], py + B[1],
    ];
    // Deterministic pseudo-random so the scatter is stable across the per-frame re-renders.
    const rnd = (n: number) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const T0 = SPAWN_VOX_T0, PERIOD = SPAWN_VOX_PERIOD;
    const seen = new Set<string>();
    const out: VoxCell[] = [];
    const denom = Math.max(1, N - 1);
    const push = (i: number, j: number, k: number, withTop: boolean) => {
      const key = `${i},${j},${k}`;
      if (seen.has(key)) return;
      seen.add(key);
      const px = Tf[0] + i * u[0] + j * v[0] + k * w[0];
      const py = Tf[1] + i * u[1] + j * v[1] + k * w[1];
      const hf = (N - 1 - k) / denom; // 0 at bottom → lands earlier
      const r = rnd(i * 31 + j * 57 + k * 91 + 3);
      out.push({
        top: withTop ? quad(px, py, u, v) : null,
        left: quad(px, py, v, w),
        right: quad(px, py, u, w),
        cx: px + (u[0] + v[0] + w[0]) / 2,
        cy: py + (u[1] + v[1] + w[1]) / 2,
        delay: Math.round(T0 + PERIOD * (0.4 * hf + 0.6 * r)),
        vx: (rnd(i * 13 + j * 7 + k * 19 + 5) - 0.5) * 42,
        vy: -(46 + rnd(i * 17 + j * 23 + k * 11 + 9) * 82),
        d: i + j + k, // painter depth: larger = farther from viewer (drawn first)
      });
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) push(i, j, kTop, true); // waterline surface
    for (let k = kTop; k < N; k++) for (let j = 0; j < N; j++) push(0, j, k, false); // left flank (i=0)
    for (let k = kTop; k < N; k++) for (let i = 0; i < N; i++) push(i, 0, k, false); // right flank (j=0)
    out.sort((a, b) => b.d - a.d); // back-to-front
    return out;
  }, [animate, block?.tx_count, block?.weight]);

  return (
    <div
      className={clsx('group relative select-none', stretchDy !== 0 && !reducedMotion && 'fw-chain-stretch')}
      style={{ width: w, height: h, opacity: depth, '--stretch-dy': `${stretchDy}px` } as React.CSSProperties}
      onClick={() => onSelect(height)}
      role="button"
      tabIndex={-1}
      aria-label={heightLabel(height)}
    >
      {/* Cube-rain on a canvas UNDER the svg (the svg is positioned so it paints above), so the big
          face panels still slide in over the pile to seal it. */}
      {animate && voxels.length > 0 && (
        <VoxelRain cells={voxels} size={size} colors={{ top: c.top, left: c.left, right: c.right }} />
      )}
      <svg
        width={w}
        height={h}
        viewBox={CUBE_VIEWBOX}
        className={clsx(loading && !reducedMotion && 'fw-loading')}
        // No drop-shadow while materializing: the spawn's own CSS animations (base pulse, panels,
        // fill-rise) would force the filter to re-rasterize every frame for ~3s — measured as the
        // single biggest spawn cost. The shadow arrives with the finished cube.
        style={{ filter: animate ? undefined : filter, display: 'block', overflow: 'visible', position: 'relative' }}
      >
        <defs>
          <linearGradient id={`${gid}-t`} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor={c.top} stopOpacity="1" />
            <stop offset="1" stopColor={c.top} stopOpacity="0.82" />
          </linearGradient>
          <linearGradient id={`${gid}-r`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c.right} />
            <stop offset="1" stopColor={c.right} stopOpacity="0.7" />
          </linearGradient>
          {fill && (
            <>
              {/* Contents gradients: bright at the waterline, deepening toward the base. */}
              <linearGradient id={`${gid}-fl`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={fill.l0} />
                <stop offset="1" stopColor={fill.l1} />
              </linearGradient>
              <linearGradient id={`${gid}-fr`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={fill.r0} />
                <stop offset="1" stopColor={fill.r1} />
              </linearGradient>
              <clipPath id={`${gid}-body`}>
                <polygon points={BODY_HEX} />
              </clipPath>
            </>
          )}
        </defs>

        {/* Spawn base: the diamond outline draws on, then fades once the panels seal. The cube-rain
            it anchors is drawn on the VoxelRain canvas behind this svg. */}
        {animate && (
          <g className="fw-spawn-out" style={{ animationDelay: `${SPAWN_ENCLOSE + 240}ms` }}>
            <path
              className="fw-spawn-base"
              d={`M ${poly(SPAWN_BASE)} Z`}
              fill="none"
              stroke="#34d399"
              strokeWidth={1.4}
              strokeDasharray={224}
              strokeDashoffset={224}
              style={{ animationDelay: `${SPAWN_BASE_AT}ms`, filter: 'drop-shadow(0 0 4px rgba(52,211,153,0.55))' }}
            />
          </g>
        )}

        {/* Finished cube as three face panels. During a spawn each slides + fades in to enclose the
            voxels; otherwise they're just the static cube. Drawn left → right → top (top on top). The
            unfilled walls are dark; the vivid contents (fullness meter) are layered on top next. */}
        <g className={clsx(animate && 'fw-panel-left')} style={animate ? { animationDelay: `${SPAWN_ENCLOSE}ms` } : undefined}>
          <polygon points={CUBE_FACES.left} fill={c.left} stroke={c.edge} strokeWidth={0.8} />
        </g>

        <g className={clsx(animate && 'fw-panel-right')} style={animate ? { animationDelay: `${SPAWN_ENCLOSE}ms` } : undefined}>
          <polygon points={CUBE_FACES.right} fill={`url(#${gid}-r)`} stroke={c.edge} strokeWidth={0.8} />
        </g>

        {/* Fullness meter: vivid contents fill the two flanks up to the waterline. Clipped to the body
            so the spawn "pour" (contents rise from the base) can't spill past the edges. */}
        {fill && (
          <g clipPath={`url(#${gid}-body)`}>
            <g className={clsx(animate && 'fw-fill-rise')} style={animate ? riseStyle : undefined}>
              <polygon points={fillLeft} fill={`url(#${gid}-fl)`} />
              <polygon points={fillRight} fill={`url(#${gid}-fr)`} />
              {/* Glowing surface line + a thin meniscus highlight just beneath it. */}
              <path
                d={waterPath}
                fill="none"
                stroke={fill.water}
                strokeWidth={1.5}
                strokeLinejoin="round"
                style={{ filter: `drop-shadow(0 0 3px ${fill.water})` }}
              />
              <path d={waterPath} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.5} strokeLinejoin="round" />
            </g>
          </g>
        )}

        {/* Face markers ride on top of the contents. */}
        <g>
          {/* BIP-110 signaling sticker, slapped onto the LEFT flank in that face's own plane.
              `matrix(50,25,0,66,0,25)` is the left face's basis (see L above): it sends the unit
              square to the parallelogram, so the sticker — cream die-cut border and all — shears
              into perspective exactly like the hazard stickers on the right flank. The u/v extents
              are picked so the artwork stays square on the face, since the face's two axes have
              different screen lengths (|u| ≈ 55.9, |v| = 66). */}
          {block?.signals_110 && (
            <g
              transform={`matrix(50,25,0,66,0,25) translate(0.13,0.10) scale(${SIGNAL_U / 64},${SIGNAL_V / 64})`}
            >
              <g transform="rotate(-7 32 32)">{SIGNAL_STICKER_BODY}</g>
            </g>
          )}
        </g>

        <g className={clsx(animate && 'fw-panel-top')} style={animate ? { animationDelay: `${SPAWN_ENCLOSE}ms` } : undefined}>
          <polygon points={CUBE_FACES.top} fill={`url(#${gid}-t)`} stroke={c.edge} strokeWidth={1} />
          {selected && (
            <polygon points={CUBE_FACES.top} fill="none" stroke="#fff" strokeWidth={1.6} opacity={0.9} />
          )}
        </g>
      </svg>

      {block && block.rdts_rule_hits.length > 0 && (
        <ViolationStickers
          rules={block.rdts_rule_hits}
          size={size}
          animate={animate}
          reducedMotion={reducedMotion}
        />
      )}

      {showLabel && (
        <div
          className={clsx(
            'pointer-events-none absolute whitespace-nowrap font-mono font-semibold tabular-nums',
            theme === 'knots' ? 'text-slate-300/90' : 'text-zinc-200/90',
          )}
          style={{
            left: '100%',
            top: '32%',
            marginLeft: Math.max(16, size * 0.18),
            fontSize: labelSize,
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          }}
        >
          {heightLabel(height)}
        </div>
      )}

      {showLabel && showDetail && block && (
        <div
          className="pointer-events-none absolute space-y-0.5 font-mono"
          style={{
            left: '100%',
            top: 'calc(32% + ' + Math.round(labelSize * 1.25) + 'px)',
            marginLeft: Math.max(16, size * 0.18),
            opacity: focusAmt,
            minWidth: 150,
          }}
        >
          <div className="text-[11px] text-zinc-400">{shortHash(block.hash)}</div>
          <div className="flex gap-3 text-[10.5px] text-zinc-500">
            <span>{formatInt(block.tx_count)} tx</span>
            <span>{formatBytes(block.size)}</span>
          </div>
          {/* Verdict and allegiance chips. Signaling gets one here for the same reason a violation
              does: the sticker on the flank can be turned away or too small to read at distance,
              so the readout has to carry it too. */}
          {(RDTS_TAG[block.rdts_verdict] || block.signals_110) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {RDTS_TAG[block.rdts_verdict] && (
                <span
                  className={clsx(
                    'rounded border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider',
                    RDTS_TAG[block.rdts_verdict].cls,
                  )}
                >
                  {RDTS_TAG[block.rdts_verdict].label}
                </span>
              )}
              {block.signals_110 && (
                <span
                  className="rounded border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-emerald-300"
                  title={SIGNAL_LABEL}
                >
                  Signaling
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const IsoBlock = memo(IsoBlockImpl);
