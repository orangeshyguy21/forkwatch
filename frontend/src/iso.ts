// Isometric geometry + physics helpers for the videogamey chain scroller.
// Everything here is pure/deterministic so it's cheap to call in a rAF loop.

import type { Block, RdtsVerdict } from './types';

// ---------------------------------------------------------------------------
// Physics / layout constants (tuned for a 1440px dark desktop).
// ---------------------------------------------------------------------------

/** Focus block anchor as a fraction of viewport height (0 = top). Higher up = less dead space above
 *  the tip when following it. */
export const ANCHOR = 0.24;

/** Iso footprint (px) of the focused, dead-centre block at zoom = 1. */
export const MAX_SIZE = 210;

/** Fisheye falloff. size = MAX_SIZE / (1 + K * |h - focus|). Bigger K = steeper. Gentle at rest —
 *  blocks only shrink hard when the velocity zoom kicks in during scrolling. */
export const K = 0.34;

/** Vertical stack ratio: gap between adjacent blocks at focus ≈ STACK * size. Kept modest so the
 *  tunnel stays dense; the focused block's own gap is widened separately via FOCUS_LIFT. */
export const STACK = 1.35;

/** Fork lane half-separation (px, CONSTANT). Lanes stay parallel & perfectly vertical — no fisheye
 *  scaling on the offset, so they don't arc in/out. Wide enough that the (now larger) focused blocks
 *  on each lane have a clear channel between them. */
export const LANE_GAP = 225;

// --- Responsive scaling ------------------------------------------------------------------------
// The scene above is tuned for a wide desktop chain viewport. On a narrow viewport (phone/tablet)
// the focused block and — worse — the two fork lanes at ±LANE_GAP overflow the screen. Rather than
// re-tune every constant per device, the component multiplies its projected geometry (block size,
// tunnel spacing, focus lift, lane gap) by a single width-derived scale. At/above FULL_SCALE_WIDTH
// the scale is exactly 1, so the desktop render is bit-for-bit unchanged.

/** Chain-viewport width (px) at/above which the scene renders at full desktop size (scale = 1). Set
 *  so that a typical desktop (≥ ~1168px window, i.e. ≥ 760px of chain after the two 204px rails) is
 *  byte-identical to the pre-responsive render; the 1440px design target sits comfortably above it.
 *  Narrower desktops — where a fork's two lanes previously overflowed into the rails — scale down. */
export const FULL_SCALE_WIDTH = 760;
/** Floor on the scale, so a very small phone still shows a legible block rather than a speck. */
export const MIN_SCALE = 0.46;
/** Chain-viewport width at which the scale bottoms out at MIN_SCALE. */
const MIN_SCALE_WIDTH = 340;

/** Uniform scale for the isometric scene given the chain-viewport width. 1 on desktop. */
export function viewportScale(w: number): number {
  if (w >= FULL_SCALE_WIDTH) return 1;
  const t = clamp((w - MIN_SCALE_WIDTH) / (FULL_SCALE_WIDTH - MIN_SCALE_WIDTH), 0, 1);
  return MIN_SCALE + t * (1 - MIN_SCALE);
}

/** Fork-lane half-separation for a chain of width `w` at the given scale. Scales with the scene but
 *  is also capped to a fraction of the viewport so the two lanes always keep a channel on-screen. */
export function laneGapFor(w: number, scale: number): number {
  return Math.min(LANE_GAP * scale, w * 0.34);
}

/** Chain-link size (px, CONSTANT — links never fisheye). */
export const LINK_RX = 4.5;
export const LINK_RY = 7.5;
export const LINK_STEP = 15;

/** Per-frame lerp of focusHeight toward its SETTLED (snapped) target — the detent glide once the
 *  wheel goes quiet. Snappy enough that landing on a block transits quickly. */
export const FOCUS_LERP = 0.2;

/** Per-frame lerp of focusHeight toward the CONTINUOUS target while actively scrolling. Higher, so
 *  the focus tracks the flying target closely (its velocity is what drives the zoom-out). */
export const FOCUS_LERP_SCROLL = 0.55;

/** Heights of speed imparted per pixel of wheel deltaY, at 1× acceleration. A single notch stays
 *  gentle; the accel multiplier below is what makes a sustained scroll build to a fast fly. */
export const WHEEL_SENS = 0.0016;

// --- Scroll acceleration + detent debounce ------------------------------------------------------
// The scroller is velocity-controlled: each wheel tick adds to a `speed` (heights/frame). Consecutive
// same-direction ticks ramp an acceleration multiplier, so continuing to scroll makes each tick shove
// harder — the chain flies faster and faster and zooms further out. A pause or reversal resets it.
// While the wheel is live, speed is only lightly damped so it SUSTAINS between notches (blocks stay
// small, the flight is smooth); once the wheel goes quiet it's damped hard so the chain settles onto
// a block quickly. The detent (snap-to-integer) is likewise suppressed until the wheel is quiet.

/** Added to the accel multiplier per consecutive same-direction tick. */
export const SCROLL_ACCEL_STEP = 0.6;
/** Ceiling on the accel multiplier. */
export const SCROLL_ACCEL_MAX = 8;
/** A gap longer than this between ticks (or a direction flip) resets acceleration to 1×. */
export const SCROLL_ACCEL_RESET_MS = 260;
/** Hard cap on scroll speed (heights/frame), so flying stays controllable. */
export const MAX_SCROLL_SPEED = 6;
/** Detent + fast-flight window: how long after the last tick the scroll is still "live". */
export const SCROLL_SETTLE_MS = 160;
/** Per-frame speed retention WHILE the wheel is live — light, so speed sustains + accumulates. */
export const SCROLL_FRICTION_ACTIVE = 0.9;
/** Per-frame speed retention once the wheel is quiet — heavier, so the glide is short and it settles. */
export const SCROLL_FRICTION_RELEASE = 0.8;
/** Speed below this (heights/frame) is treated as stopped. */
export const SCROLL_MVEL_EPS = 0.02;

/** Per-frame lerp for the zoom spring. */
export const ZOOM_LERP = 0.14;

/** Scroll speed (heights/frame) -> zoom. target = 1 + min(ZOOM_GAIN*|v|, ZOOM_MAX-1). Tuned so even
 *  a modest scroll starts shrinking blocks and a fast fly pushes them small. */
export const ZOOM_GAIN = 0.62;
export const ZOOM_MAX = 4.2;

// ---------------------------------------------------------------------------
// Cube geometry. A single unit cube drawn in a normalized viewBox; the SVG is
// then scaled to `size` px by the component. 2:1 isometric.
// ---------------------------------------------------------------------------

export const CUBE_VIEWBOX = '0 0 100 116';

export interface CubeFaces {
  top: string;
  left: string;
  right: string;
}

// Top diamond peaks at y=0, seats at y=50; body drops to y=116.
export const CUBE_FACES: CubeFaces = {
  top: '50,0 100,25 50,50 0,25',
  left: '0,25 50,50 50,116 0,91',
  right: '100,25 50,50 50,116 100,91',
};

/** Aspect ratio (height / width) of the cube artwork, for sizing the SVG box. */
export const CUBE_ASPECT = 116 / 100;

// ---------------------------------------------------------------------------
// Log-tunnel vertical layout. Spacing shrinks with distance to match the size
// falloff, so blocks recede into a dense vanishing tunnel with no dead zones.
//   gap(t) = C / (1 + K|t|),  C = STACK * MAX_SIZE / sqrt(zoom)
//   P(d)   = ∫₀ᵈ gap = sign(d) * (C/K) * ln(1 + K|d|)
// ---------------------------------------------------------------------------

function tunnelC(zoom: number): number {
  return (STACK * MAX_SIZE) / Math.sqrt(zoom);
}

/** Screen offset (px, signed) from the anchor for a block `d` heights from focus. */
export function posP(d: number, zoom: number): number {
  const C = tunnelC(zoom);
  const s = d < 0 ? -1 : 1;
  return s * (C / K) * Math.log(1 + K * Math.abs(d));
}

// ---------------------------------------------------------------------------
// Fisheye scale + depth.
// ---------------------------------------------------------------------------

/** Per-block iso footprint given its distance (in heights) from focus + zoom. */
export function sizeFor(dist: number, zoom: number): number {
  return MAX_SIZE / (1 + K * Math.abs(dist)) / Math.sqrt(zoom);
}

/** Extra px separation injected around the focused block so its chain links have room to read.
 *  Saturates within ~1 block (tanh), so ONLY the focus's immediate gaps are widened; blocks further
 *  out are just shifted by a near-constant, keeping the tunnel dense. */
export const FOCUS_LIFT = 88;
export function focusLift(dist: number): number {
  const s = dist < 0 ? -1 : 1;
  return s * FOCUS_LIFT * Math.tanh(Math.abs(dist) / 0.9);
}

/** Size emphasis peaking on the focused block — a "hero" pop so exactly one block dominates. */
export const FOCUS_POP = 0.18;
export function focusPop(dist: number): number {
  return 1 + FOCUS_POP * Math.exp(-(dist * dist) / (2 * 0.55 * 0.55));
}

/** Atmospheric depth: 1 at focus -> fades with distance. Used for opacity. */
export function depthFor(dist: number): number {
  return Math.max(0.42, 1 - Math.abs(dist) * 0.06);
}

/** How "focused" a block is in 0..1 (drives detail reveal). */
export function focusAmount(dist: number): number {
  return Math.max(0, 1 - Math.abs(dist) * 0.7);
}

/** Velocity (heights/frame) -> target zoom. */
export function velocityToZoom(vel: number): number {
  return 1 + Math.min(ZOOM_GAIN * Math.abs(vel), ZOOM_MAX - 1);
}

// ---------------------------------------------------------------------------
// Theming.
// ---------------------------------------------------------------------------

export type BlockTheme = 'core' | 'knots' | 'shared';

/** Vivid "contents" fill for the mempool-style fullness meter drawn inside the cube. Each visible
 *  flank gets a two-stop vertical gradient (bright near the waterline → deep at the base), plus a
 *  glowing waterline colour. Right flank runs a touch brighter than the left to read as lit. */
export interface FillColors {
  l0: string; // left flank, at waterline
  l1: string; // left flank, at base
  r0: string; // right flank, at waterline
  r1: string; // right flank, at base
  water: string; // glowing surface line
}

export interface ThemeColors {
  top: string;
  left: string; // unfilled wall (the empty part of the container)
  right: string;
  edge: string;
  glow: string | null;
  fill: FillColors | null;
}

type Palette = Omit<ThemeColors, 'glow'>;

/** A complete chain colorway. `standard` dresses the canonical chain — BOTH the pre-fork spine
 *  ('shared') and the winning lane in a fork ('core', ~99% hashrate, always reaches the tip) — so
 *  the standard chain keeps one colour before and during a fork. `orphan` dresses the losing
 *  minority branch ('knots'). `connectors` are the chain-link colours: [full, faint] per lane plus
 *  the fork-junction stub. Swap the entire look by changing ACTIVE_COLORWAY below. */
export interface Colorway {
  standard: Palette;
  orphan: Palette;
  connectors: {
    standard: [full: string, faint: string];
    standardJunction: string;
    orphan: [full: string, faint: string];
    orphanJunction: string;
  };
}

const COLORWAYS = {
  // Electric indigo standard + crimson orphan. The violet-blue sits clear of mempool.space's
  // mid-azure; red is its complement, so the fork split reads instantly.
  'indigo-crimson': {
    standard: {
      top: '#5566f2', left: '#12163a', right: '#191d4a', edge: 'rgba(160,170,255,0.62)',
      fill: { l0: '#6d7bff', l1: '#171b45', r0: '#8794ff', r1: '#20265a', water: 'rgba(196,204,255,0.95)' },
    },
    orphan: {
      top: '#c23a34', left: '#2a0b09', right: '#38100c', edge: 'rgba(248,113,113,0.7)',
      fill: { l0: '#e04b3f', l1: '#571410', r0: '#f26056', r1: '#6b1a14', water: 'rgba(255,186,176,0.95)' },
    },
    connectors: {
      standard: ['rgba(135,148,255,0.64)', 'rgba(120,132,240,0.32)'],
      standardJunction: 'rgba(135,148,255,0.62)',
      orphan: ['rgba(240,96,86,0.74)', 'rgba(240,96,86,0.38)'],
      orphanJunction: 'rgba(240,96,86,0.72)',
    },
  },
  // Bitcoin orange standard + cold steel orphan. The canonical chain glows on-theme; the losing
  // branch greys out — it visually dies. Frees red for actual violation glows only.
  'orange-steel': {
    standard: {
      top: '#f7931a', left: '#3a1e05', right: '#48260a', edge: 'rgba(255,192,112,0.6)',
      fill: { l0: '#ffa733', l1: '#5a2e08', r0: '#ffb84d', r1: '#6e3a0d', water: 'rgba(255,214,150,0.95)' },
    },
    orphan: {
      top: '#48535e', left: '#12171b', right: '#1a2026', edge: 'rgba(162,182,198,0.55)',
      fill: { l0: '#6b7d8a', l1: '#1a2228', r0: '#7e919e', r1: '#232d34', water: 'rgba(184,202,216,0.9)' },
    },
    connectors: {
      standard: ['rgba(255,167,51,0.64)', 'rgba(230,150,60,0.32)'],
      standardJunction: 'rgba(255,167,51,0.62)',
      orphan: ['rgba(150,170,186,0.66)', 'rgba(140,160,176,0.34)'],
      orphanJunction: 'rgba(150,170,186,0.64)',
    },
  },
  // Original teal-blue standard + steel-grey orphan. The look Forkwatch shipped with, but the
  // losing branch greys out (as the monochrome Core lane used to) instead of going green.
  'blue-steel': {
    standard: {
      top: '#33444f', left: '#0a1216', right: '#0f1b22', edge: 'rgba(148,196,180,0.5)',
      fill: { l0: '#2f8ba1', l1: '#123039', r0: '#3aa3bb', r1: '#173b46', water: 'rgba(158,224,234,0.9)' },
    },
    orphan: {
      top: '#3a3a40', left: '#141416', right: '#1d1d20', edge: 'rgba(244,244,245,0.55)',
      fill: { l0: '#6b6b76', l1: '#2c2c31', r0: '#82828d', r1: '#37373d', water: 'rgba(232,236,244,0.95)' },
    },
    connectors: {
      standard: ['rgba(160,185,205,0.62)', 'rgba(150,182,202,0.34)'],
      standardJunction: 'rgba(160,185,205,0.62)',
      orphan: ['rgba(224,224,228,0.64)', 'rgba(210,212,218,0.3)'],
      orphanJunction: 'rgba(224,224,228,0.62)',
    },
  },
} satisfies Record<string, Colorway>;

/** The active chain colorway. Change this ONE line to swap the whole look. */
export const ACTIVE_COLORWAY: keyof typeof COLORWAYS = 'blue-steel';

const CW: Colorway = COLORWAYS[ACTIVE_COLORWAY];

/** Chain-link connector colours for the active colorway (consumed by IsometricChain). */
export const connectorColors = CW.connectors;

const SHARED = CW.standard; // canonical / standard chain (pre-fork spine)
const CORE = CW.standard; // canonical winning lane in a fork
const KNOTS = CW.orphan; // orphaned minority branch

const LOADING: Omit<ThemeColors, 'glow'> = {
  top: '#232329',
  left: '#101014',
  right: '#17171c',
  edge: 'rgba(255,255,255,0.14)',
  fill: null,
};

/** Verdict accent glow colour (edge glow), or null. We NO LONGER glow would-violate blocks (the
 *  mainchain gets busy) — those are shown with a corner marker instead. Only a block actually
 *  rejected by Knots (invalid, on the fork) keeps a red glow. */
export function verdictGlow(verdict: RdtsVerdict | undefined): string | null {
  return verdict === 'invalid' ? 'rgba(239,68,68,0.95)' : null;
}

export function themeColors(
  theme: BlockTheme,
  verdict: RdtsVerdict | undefined,
  loading: boolean,
): ThemeColors {
  const base = loading ? LOADING : theme === 'core' ? CORE : theme === 'knots' ? KNOTS : SHARED;
  return { ...base, glow: loading ? null : verdictGlow(verdict) };
}

// ---------------------------------------------------------------------------
// Block fullness (mempool-style). Blocks are capped at 4M weight units; that's
// the true "how full" metric. Tx-count is a fallback for regtest, where weight
// is tiny. A small floor keeps even near-empty blocks showing a readable sliver.
// ---------------------------------------------------------------------------

export const MAX_WEIGHT = 4_000_000;

export function fullness(block: Block | undefined): number {
  if (!block) return 0;
  const byWeight = block.weight / MAX_WEIGHT;
  const byTx = block.tx_count / 4000;
  return clamp(Math.max(byWeight, byTx), 0.06, 1);
}

// ---------------------------------------------------------------------------
// Misc.
// ---------------------------------------------------------------------------

/** Difficulty epoch (retarget window) size + helper. */
export const EPOCH = 2016;
export function epochOf(h: number): number {
  return Math.floor(h / EPOCH);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
