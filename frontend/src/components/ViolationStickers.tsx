import { memo } from 'react';
import { clsx } from '../util';

// Die-cut hazard stickers — one per RDTS rule a block trips. On the block they're stuck to the RIGHT
// isometric flank: the cluster is sheared by the 2:1 iso matrix so each reads as painted onto that
// face in perspective. During a spawn they slap on one-by-one as the FINAL step, after the panels
// lock. `StickerIcon` renders a single upright sticker for reuse in the block sidebar.

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

// Radiation trefoil blades (three trapezoids at 120°) + hub, precomputed in the 64 viewBox.
const TREFOIL = (
  <g fill="#1c1917">
    <path d="M35.8 24.9 L42.3 12.6 L21.7 12.6 L28.3 24.9 Z" />
    <path d="M24.0 32.3 L10.0 32.8 L20.3 50.7 L27.8 38.8 Z" />
    <path d="M36.2 38.8 L43.7 50.7 L54.0 32.8 L40.0 32.3 Z" />
    <circle cx="32" cy="32" r="6.3" />
  </g>
);

// rule -> sticker artwork. viewBox is 0 0 64 64.
const STICKERS: Record<number, StickerDef> = {
  1: {
    label: 'oversized scriptPubKey / OP_RETURN',
    body: (
      <>
        <path d="M32 7 L59 55 L5 55 Z" {...cut('#f5b312')} />
        <rect x="29" y="25" width="6" height="15" rx="3" fill="#1c1917" />
        <circle cx="32" cy="47.5" r="3.4" fill="#1c1917" />
      </>
    ),
  },
  2: {
    label: 'data push / witness item > 256 bytes',
    body: (
      <>
        <rect x="8" y="8" width="48" height="48" rx="13" {...cut('#db2777')} />
        <rect x="18" y="21" width="20" height="5.4" rx="2.7" fill="#fff" />
        <rect x="18" y="30" width="28" height="5.4" rx="2.7" fill="#fff" />
        <rect x="18" y="39" width="14" height="5.4" rx="2.7" fill="#fff" />
        <path d="M46 26 l7 6.7 -7 6.7 Z" fill="#fff" />
      </>
    ),
  },
  3: {
    label: 'spends undefined witness version',
    body: (
      <>
        <path d="M32 5 L59 32 L32 59 L5 32 Z" {...cut('#8b5cf6')} />
        <text x="32" y="43" textAnchor="middle" fontFamily="ui-monospace, monospace" fontWeight="800" fontSize="30" fill="#fff">?</text>
      </>
    ),
  },
  4: {
    label: 'Taproot annex',
    body: (
      <>
        <path d="M20 10 L54 10 L54 54 L20 54 L8 32 Z" {...cut('#0d9488')} />
        <circle cx="19" cy="32" r="4.4" fill="#f7f2e4" />
        <path
          d="M40 22 v14 a6 6 0 0 1 -12 0 v-11 a3.4 3.4 0 0 1 6.8 0 v11"
          fill="none"
          stroke="#f7f2e4"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  5: {
    label: 'control block > 257 bytes',
    body: (
      <>
        <rect x="8" y="8" width="48" height="48" rx="12" {...cut('#ea580c')} />
        <rect x="21" y="21" width="22" height="22" rx="3" fill="none" stroke="#fff" strokeWidth="3.2" />
        <path d="M15 15 l9 0 M15 15 l0 9 M15 15 l11 11" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path d="M49 49 l-9 0 M49 49 l0 -9 M49 49 l-11 -11" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      </>
    ),
  },
  6: {
    label: 'OP_SUCCESS in tapscript',
    body: (
      <>
        <circle cx="32" cy="32" r="26" {...cut('#facc15')} />
        {TREFOIL}
      </>
    ),
  },
  7: {
    label: 'OP_IF / OP_NOTIF in tapscript',
    body: (
      <>
        <path
          d="M14 20 Q10 9 24 9 Q34 6 44 11 Q57 12 54 26 Q60 36 50 44 Q48 57 34 53 Q20 58 15 46 Q4 39 10 29 Z"
          {...cut('#ef4444')}
        />
        <path
          d="M18 34 q6 -12 12 -2 q5 9 11 -1 q4 -7 8 0"
          fill="none"
          stroke="#fff"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
    <rect x="8" y="8" width="48" height="48" rx="12" {...cut('#10b981')} />
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

/** A single upright die-cut sticker — reused in the sidebar next to each violation. */
export function StickerIcon({ rule, size, className }: { rule: number; size: number; className?: string }) {
  const def = STICKERS[rule];
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
  rules: number[];
  /** Block iso footprint (px). */
  size: number;
  animate: boolean;
  reducedMotion: boolean;
}

// 2:1 isometric shear for the cube's RIGHT face: verticals stay vertical, horizontals slope up-right.
const RIGHT_FACE_ISO = 'matrix(1, -0.5, 0, 1, 0, 0)';

function ViolationStickersImpl({ rules, size, animate, reducedMotion }: Props) {
  const known = rules.filter((r) => STICKERS[r]);
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
      {known.map((r, i) => {
        const rot = ROT[i % ROT.length];
        return (
          <div
            key={r}
            className={clsx('absolute', doAnim && 'fw-sticker')}
            style={{
              left: (LX[i % LX.length] || 0.08) * size,
              top: size * 0.03 + i * step,
              width: s,
              height: s,
              zIndex: 100 + i,
              transform: `rotate(${rot}deg)`,
              ...(doAnim
                ? ({ '--rot': `${rot}deg`, animationDelay: `${STICKER_AT + i * STICKER_STAGGER}ms` } as React.CSSProperties)
                : {}),
            }}
            title={STICKERS[r].label}
          >
            <StickerIcon rule={r} size={s} />
          </div>
        );
      })}
    </div>
  );
}

export const ViolationStickers = memo(ViolationStickersImpl);
