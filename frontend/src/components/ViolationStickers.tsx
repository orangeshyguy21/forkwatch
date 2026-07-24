import { memo } from 'react';
import { clsx } from '../util';

// Die-cut violation stickers — one per distinct RDTS violation *kind* a block trips (so the two
// rule-1 kinds, say, are two different stickers). On the block they're stuck to the RIGHT isometric
// flank: the cluster is sheared by the 2:1 iso matrix so each reads as painted onto that face in
// perspective. During a spawn they slap on one-by-one as the FINAL step, after the panels lock.
// `StickerIcon` renders a single upright sticker for reuse in the block sidebar.

/** When the stickers start slapping on, ms from materialize — after the panels finish
 *  (SPAWN_ENCLOSE 2350 + panel slide 440 ≈ 2790 in IsoBlock). */
export const STICKER_AT = 2900;
const STICKER_STAGGER = 150;

const CREAM = '#f7f2e4';
const DIECUT = 4.5; // cream border width in the 64-unit viewBox

// A filled shape whose cream die-cut border hugs its silhouette (stroke painted behind the fill).
const cut = (fill: string) => ({
  fill,
  stroke: CREAM,
  strokeWidth: DIECUT,
  paintOrder: 'stroke' as const,
  strokeLinejoin: 'round' as const,
});

interface StickerDef {
  label: string;
  body: JSX.Element;
}

const INK = '#1c1917'; // facial features — eyes, mouths

// A friendly smile/curve stroked in ink (shared across the mascot family).
const smile = (d: string, w = 3) => ({
  d,
  fill: 'none' as const,
  stroke: INK,
  strokeWidth: w,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

// kind -> sticker artwork. viewBox is 0 0 64 64. One sticker per *distinct violation kind* (the
// backend's `violation.kind`), NOT per rule — so a block hitting two rule-1 kinds shows two different
// stickers. Deliberate style mix: a few keep a friendly face (parcel, ghost, cube), the rest are flat
// glyphs — some carried over from the original geometric set (data-push lines, the Taproot tag). The
// only hard rule: nothing that reads as a hazard/warning. Keys MUST match the backend kind strings.
const STICKERS: Record<string, StickerDef> = {
  // ── Rule 1 — two kinds, two stickers. They frequently co-occur on the same block, so they get
  //    DISTINCT colours (sky key vs amber return-arrow) rather than sharing the rule-1 amber. ──
  // Flat: a simple key — scriptPubKey is the pub*key* locking script. Sky, so it stands apart from
  // the amber OP_RETURN it usually sits next to. No face.
  'scriptPubKey > 34 bytes': {
    label: 'scriptPubKey > 34 bytes',
    body: (
      <>
        {/* circle — a coin/token silhouette */}
        <circle cx="32" cy="32" r="25" {...cut('#0ea5e9')} />
        <circle cx="32" cy="21" r="8.5" fill="none" stroke={CREAM} strokeWidth="5" />
        <path d="M32 28.5 L32 50" fill="none" stroke={CREAM} strokeWidth="5" strokeLinecap="round" />
        <path d="M32 41 L40 41 M32 48 L37.5 48" fill="none" stroke={CREAM} strokeWidth="5" strokeLinecap="round" />
      </>
    ),
  },
  // Flat: a bold return-arrow (⏎) — OP_RETURN, the nul-data output. No face.
  'OP_RETURN > 83 bytes': {
    label: 'OP_RETURN > 83 bytes',
    body: (
      <>
        <rect x="8" y="8" width="48" height="48" rx="14" {...cut('#f5b312')} />
        <path d="M45 19 L45 33 L23 33" fill="none" stroke={CREAM} strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M29 26 L22 33 L29 40" fill="none" stroke={CREAM} strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },

  // ── Rule 2 (pink) — two kinds, two stickers ──────────────────────────────
  // OLD STYLE, flat: the original data-push glyph (three lines + fast-forward). No face.
  'output data push > 256 bytes': {
    label: 'output data push > 256 bytes',
    body: (
      <>
        {/* capsule — a wide data-stream pill */}
        <rect x="6" y="15" width="52" height="34" rx="17" {...cut('#db2777')} />
        <rect x="18" y="21" width="20" height="5.4" rx="2.7" fill={CREAM} />
        <rect x="18" y="30" width="28" height="5.4" rx="2.7" fill={CREAM} />
        <rect x="18" y="39" width="14" height="5.4" rx="2.7" fill={CREAM} />
        <path d="M46 26 l7 6.7 -7 6.7 Z" fill={CREAM} />
      </>
    ),
  },
  // Flat: witness blob framed in curly braces { … }. Distinct from the push lines. No face.
  'witness item > 256 bytes': {
    label: 'witness item > 256 bytes',
    body: (
      <>
        {/* hexagon — a data cell */}
        <path d="M17 9 L47 9 L58 32 L47 55 L17 55 L6 32 Z" {...cut('#db2777')} />
        <path d="M25 18 q-6 0 -6 6 q0 5 -4 8 q4 3 4 8 q0 6 6 6" fill="none" stroke={CREAM} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M39 18 q6 0 6 6 q0 5 4 8 q-4 3 -4 8 q0 6 -6 6" fill="none" stroke={CREAM} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="27" cy="32" r="2.4" fill={CREAM} />
        <circle cx="32" cy="32" r="2.4" fill={CREAM} />
        <circle cx="37" cy="32" r="2.4" fill={CREAM} />
      </>
    ),
  },

  // ── Rule 3 (violet) — friendly "unknown" ghost. Face. ────────────────────
  'spends undefined witness version': {
    label: 'spends undefined witness version',
    body: (
      <>
        <path d="M11 34 A21 21 0 0 1 53 34 V50 l-10.5 7 l-10.5 -7 l-10.5 7 L11 50 Z" {...cut('#8b5cf6')} />
        <circle cx="25" cy="33" r="3.2" fill={INK} />
        <circle cx="39" cy="33" r="3.2" fill={INK} />
        <ellipse cx="32" cy="42" rx="3" ry="3.6" fill={INK} />
        <text x="46" y="19" textAnchor="middle" fontFamily="ui-monospace, monospace" fontWeight="800" fontSize="17" fill={CREAM}>?</text>
      </>
    ),
  },

  // ── Rule 4 (blue) — OLD STYLE tag glyph (the "annex/attached" label). Flat. Blue, not teal, so
  //    it stays distinct from the teal-emerald block flank it sits on. ──
  'Taproot annex': {
    label: 'Taproot annex',
    body: (
      <>
        <path d="M20 10 L54 10 L54 54 L20 54 L8 32 Z" {...cut('#3b82f6')} />
        <circle cx="19" cy="32" r="4.4" fill={CREAM} />
        <path
          d="M40 22 v14 a6 6 0 0 1 -12 0 v-11 a3.4 3.4 0 0 1 6.8 0 v11"
          fill="none"
          stroke={CREAM}
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },

  // ── Rule 5 (orange) — over-grown iso cube (on-brand) + a size caliper. Face. ──
  'control block > 257 bytes': {
    label: 'control block > 257 bytes',
    body: (
      <>
        <path d="M32 8 L54 19 L32 30 L10 19 Z" {...cut('#ea580c')} />
        <path d="M10 19 L32 30 L32 54 L10 43 Z" {...cut('#ea580c')} />
        <path d="M54 19 L32 30 L32 54 L54 43 Z" {...cut('#ea580c')} />
        <path d="M10 19 L32 30 L54 19 M32 30 L32 54" fill="none" stroke="#b8460a" strokeWidth="1.8" />
        <circle cx="21" cy="34" r="2.6" fill={INK} />
        <circle cx="30" cy="38.5" r="2.6" fill={INK} />
        <path {...smile('M20 42 q6 5 12 -0.5', 2.4)} />
        <path d="M39 33 L39 47 M37 34.5 L41 33.2 M37 45.5 L41 46.8" fill="none" stroke={CREAM} strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },

  // ── Rule 6 (yellow) — flat check (OP_SUCCESS literally succeeds). Was the radiation trefoil. ──
  'OP_SUCCESS in tapscript': {
    label: 'OP_SUCCESS in tapscript',
    body: (
      <>
        {/* scalloped award seal — 10 bumps around a radius-20 circle */}
        <path
          d="M52 32 A6.4 6.4 0 0 1 48.2 43.8 A6.4 6.4 0 0 1 38.2 51 A6.4 6.4 0 0 1 25.8 51 A6.4 6.4 0 0 1 15.8 43.8 A6.4 6.4 0 0 1 12 32 A6.4 6.4 0 0 1 15.8 20.2 A6.4 6.4 0 0 1 25.8 13 A6.4 6.4 0 0 1 38.2 13 A6.4 6.4 0 0 1 48.2 20.2 A6.4 6.4 0 0 1 52 32 Z"
          {...cut('#facc15')}
        />
        <path d="M20 33 L28 42 L44 22" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },

  // ── Rule 7 (red) — flat two-way branch (IF splits). Was the warning splat. ──
  'OP_IF/OP_NOTIF in tapscript': {
    label: 'OP_IF/OP_NOTIF in tapscript',
    body: (
      <>
        {/* shield/crest */}
        <path d="M12 13 L52 13 L52 31 Q52 47 32 56 Q12 47 12 31 Z" {...cut('#ef4444')} />
        <circle cx="32" cy="45" r="3.2" fill={CREAM} />
        <path d="M32 45 L32 32 M32 32 L22 22 M32 32 L42 22" fill="none" stroke={CREAM} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M22 22 l-0.5 5.4 M22 22 l5.2 1.2 M42 22 l0.5 5.4 M42 22 l-5.2 1.2" fill="none" stroke={CREAM} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
};

export const SIGNAL_LABEL = 'signals BIP-110 (bit 4 set)';

/**
 * The BIP-110 signaling sticker — same die-cut family as the hazard stickers, but a badge of
 * allegiance rather than a warning: a cross with the BIP number under it. Exported as bare artwork
 * so it can be painted onto the cube's flank in perspective as well as sit upright in the sidebar.
 */
export const SIGNAL_STICKER_BODY = (
  <>
    <rect x="8" y="8" width="48" height="48" rx="12" {...cut('#a855f7')} />
    {/* Latin cross, drawn as one outline so the die-cut reads cleanly at small sizes. */}
    <path
      d="M29.2 13 h5.6 v7 h7.2 v5.6 h-7.2 v13 h-5.6 v-13 h-7.2 v-5.6 h7.2 z"
      fill={CREAM}
    />
    <text
      x="32"
      y="52"
      textAnchor="middle"
      fontFamily="ui-monospace, monospace"
      fontWeight="800"
      fontSize="14"
      fill={CREAM}
    >
      110
    </text>
  </>
);

/** Upright signaling sticker, for the block sidebar. */
export function SignalStickerIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', overflow: 'visible', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.5))' }}
      role="img"
      aria-label={SIGNAL_LABEL}
    >
      {SIGNAL_STICKER_BODY}
    </svg>
  );
}

/** A single upright die-cut sticker — reused in the sidebar next to each violation. Keyed by the
 *  backend's violation `kind`; an unrecognized kind renders nothing. */
export function StickerIcon({ kind, size, className }: { kind: string; size: number; className?: string }) {
  const def = STICKERS[kind];
  if (!def) return null;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', overflow: 'visible', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.5))' }}
      role="img"
      aria-label={def.label}
    >
      {def.body}
    </svg>
  );
}

// Playful per-slot tilt + zig-zag so the pile looks hand-stuck, not gridded (in the face's own plane).
const ROT = [-9, 7, -6, 10, -4, 8, -11];
const LX = [0.06, 0.13, 0.04, 0.15, 0.08, 0.12, 0.05]; // × size, across the flank

interface Props {
  /** Distinct violation kinds for this block (one sticker each), rule/severity-ordered. */
  kinds: string[];
  /** Block iso footprint (px). */
  size: number;
  animate: boolean;
  /** When the first sticker slaps on, ms from materialize (defaults to the spawn's STICKER_AT;
   *  the page-load intro passes a much earlier beat since it skips the cube rain). */
  at?: number;
  reducedMotion: boolean;
}

// 2:1 isometric shear for the cube's RIGHT face: verticals stay vertical, horizontals slope up-right.
const RIGHT_FACE_ISO = 'matrix(1, -0.5, 0, 1, 0, 0)';

function ViolationStickersImpl({ kinds, size, animate, at, reducedMotion }: Props) {
  const known = kinds.filter((k) => STICKERS[k]);
  if (known.length === 0) return null;
  const s = size * 0.27; // sticker px (pre-shear)
  const step = s * 0.55; // vertical pile step (stickers still overlap, but less — each one reads clearly)
  const doAnim = animate && !reducedMotion;

  return (
    // Anchored at the right face's front-top corner (0.5·size, 0.5·size) and sheared onto that face,
    // so the whole pile sits in the flank's plane.
    <div
      className="pointer-events-none absolute"
      style={{
        left: size * 0.5,
        top: size * 0.5,
        transformOrigin: '0 0',
        transform: RIGHT_FACE_ISO,
      }}
    >
      {known.map((k, i) => {
        const rot = ROT[i % ROT.length];
        return (
          <div
            key={k}
            className={clsx('absolute', doAnim && 'fw-sticker')}
            style={{
              left: (LX[i % LX.length] || 0.08) * size,
              top: size * 0.03 + i * step,
              width: s,
              height: s,
              zIndex: 100 + i,
              transform: `rotate(${rot}deg)`,
              ...(doAnim
                ? ({ '--rot': `${rot}deg`, animationDelay: `${(at ?? STICKER_AT) + i * STICKER_STAGGER}ms` } as React.CSSProperties)
                : {}),
            }}
            title={STICKERS[k].label}
          >
            <StickerIcon kind={k} size={s} />
          </div>
        );
      })}
    </div>
  );
}

export const ViolationStickers = memo(ViolationStickersImpl);
