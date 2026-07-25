import { memo, useEffect, useMemo, useRef } from 'react';
import { ANCHOR, MAX_SIZE, STACK } from '../iso';

/**
 * The chain's backdrop: an isometric ground lattice with a field of drifting motes above it. The
 * pieces can be isolated with `?bg=` to compare them:
 *
 *   both  (default) — the lattice with the mote field over it.
 *   lattice         — ground only: an isometric lattice on the cubes' own 2:1 axes, two planes at
 *                     different depths, parallaxing against the chain.
 *   field           — motes only: three depths; reads as stillness at the tip and as speed when
 *                     you fly through history.
 *   off             — the flat ground we shipped with (for A/B).
 *
 * PERFORMANCE CONTRACT. This sits behind a view that re-renders every frame while the focus glides,
 * so it must never re-render with it and must never repaint. Both are satisfied the same way: the
 * component is memo'd behind *stable ref* props (so React skips it entirely), and its own rAF writes
 * `transform` on a handful of absolutely-positioned layers — a compositor-only change. Nothing here
 * ever touches layout or paint after mount.
 *
 * Every layer is a repeating background whose tile is periodic in y, so the parallax offset is taken
 * modulo the tile height: the transform stays within one tile no matter how far the chain has
 * travelled, and the layers only need to overhang by one tile to cover the gap it opens.
 */

type BackdropMode = 'lattice' | 'field' | 'both' | 'off';

/** Reads `?bg=`; anything unrecognized (or absent) gets the full backdrop. */
function backdropMode(): BackdropMode {
  const p = new URLSearchParams(window.location.search).get('bg');
  return p === 'field' || p === 'lattice' || p === 'off' ? p : 'both';
}

/** Screen px the chain travels per block height at rest, at scene scale 1 — the reference the
 *  parallax rates are fractions of. A rate of 0.15 therefore moves a plane ~42px for every block
 *  scrolled on a desktop. */
const PX_PER_HEIGHT = STACK * MAX_SIZE;

/**
 * Vertical overhang a plane needs: it is translated by up to one tile period, so it must extend that
 * far past the viewport or it would expose an uncovered strip at its edge. Sized per plane rather
 * than at one worst-case value because each of these is a compositor layer, and a layer costs
 * width × height × 4 bytes of GPU memory for as long as the page is open — which on the wall display
 * this thing lives on is memory spent every hour of every day. The fine lattice needs 46px, not 320.
 *
 * Horizontal overhang is zero: the transform only ever translates in y, and the `zoomScale` planes
 * only ever scale UP (zoom ≥ 1), which covers more, never less.
 */
const overhangFor = (period: number) => Math.ceil(period) + 8;

/**
 * Floor on how far the TILE shrinks with the scene, even though the parallax distance follows
 * `viewportScale` exactly.
 *
 * The two are separate concerns and want different treatment. Parallax rate is correctness — a
 * plane must move at a fixed fraction of the chain's travel or the depth cue inverts, so it takes
 * the scale unmodified. Tile size is legibility: `viewportScale` bottoms out at 0.46, which drops
 * the fine lattice from 38px to 17px — under the grain, at 3% opacity, behind a mask. At 320px wide
 * the backdrop simply disappeared, so a phone got none of the depth this was added for.
 */
const TILE_SCALE_FLOOR = 0.72;

// ---------------------------------------------------------------------------
// Tiles. Data-URI SVG rather than hand-authored markup: `img-src 'self' data:`
// is in the CSP (see main.rs), and a background-image is resolution-independent.
// ---------------------------------------------------------------------------

const svgUrl = (body: string, w: number, h: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`,
  )}")`;

/**
 * One lattice tile: the two line families of a 2:1 isometric grid — the SAME slopes as the cubes'
 * top faces (±0.5), which is what makes the grid read as the ground they stand on rather than as
 * generic graph paper.
 *
 * The tile is `2h × h`, so each diagonal runs corner to corner at exactly ±h/2h = ±0.5 and lands on
 * the neighbouring tile's origin — the lines join across tile seams into continuous infinite lines,
 * and the whole pattern is periodic in y with period `h`.
 */
function latticeTile(h: number, opacity: number, width: number): string {
  const w = h * 2;
  const body =
    `<g stroke="#34e0ce" stroke-opacity="${opacity}" stroke-width="${width}" fill="none">` +
    `<path d="M0 0L${w} ${h}"/><path d="M0 ${h}L${w} 0"/></g>`;
  return svgUrl(body, w, h);
}

/** Deterministic PRNG, so the mote fields are identical on every load (and every device). */
function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One depth of the mote field: a `g × g` jittered grid of dots in a `size` square, which tiles in
 * both axes.
 *
 * Stratified rather than uniformly random on purpose. Pure random scatter clumps, and in a tile that
 * clump repeats every `size` px — which is instantly readable as wallpaper, and was exactly what the
 * first pass looked like. One dot per cell, jittered inside it, spreads evenly enough that the tile
 * seam disappears while still looking unplanned.
 */
function moteTile(seed: number, size: number, g: number, r: number, opacity: number): string {
  const rnd = mulberry(seed);
  const cell = size / g;
  let body = '';
  for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) {
    const x = ((gx + 0.14 + rnd() * 0.72) * cell).toFixed(1);
    const y = ((gy + 0.14 + rnd() * 0.72) * cell).toFixed(1);
    // A minority of motes wear the chain's emerald; the rest are a cold near-white, so the field
    // reads as depth rather than as a second coloured element competing with the blocks.
    const teal = rnd() < 0.28;
    const rr = (r * (0.62 + rnd() * 0.78)).toFixed(2);
    const op = (opacity * (0.5 + rnd() * 0.5)).toFixed(3);
    body += `<circle cx="${x}" cy="${y}" r="${rr}" fill="${teal ? '#34e0ce' : '#cfeee7'}" fill-opacity="${op}"/>`;
  }
  return svgUrl(body, size, size);
}

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

interface Plane {
  key: string;
  image: string;
  /** Tile height at scene scale 1 — also the y-period the parallax offset is reduced modulo. */
  period: number;
  /** Tile width at scene scale 1 (2× the period for a lattice, square for a mote field). */
  tileW: number;
  /** Fraction of the chain's own travel this plane moves — the depth cue. */
  rate: number;
  /** Continuous drift (px/sec) so the plane still breathes when the chain is parked at the tip. */
  drift: number;
  /** Extra scale per unit of (zoom - 1): a nearby plane pushing past you as the chain flies. */
  zoomScale: number;
  /** Radial mask, so a plane dissolves toward the edges instead of ending at them. */
  mask: string;
}

const SPINE_MASK =
  'radial-gradient(ellipse 78% 84% at 50% 40%, #000 0%, #000 46%, rgba(0,0,0,0.5) 76%, transparent 100%)';
const FIELD_MASK =
  'radial-gradient(ellipse 88% 92% at 50% 42%, #000 0%, #000 55%, rgba(0,0,0,0.5) 82%, transparent 100%)';

/** Far plane is fine and slow, near plane is coarse and quick — the perspective ordering, so the
 *  two grids read as one space at two depths rather than as two overlaid textures. */
// STRENGTH. These opacities are the whole dial — the backdrop must stay beneath notice, since it
// shares the screen with a countdown clock and glowing cubes that are the actual subject. Tuned so
// the structure is legible when you look for it and invisible when you are reading the numbers.
const LATTICE_PLANES: Plane[] = [
  { key: 'lat-far', image: latticeTile(38, 0.03, 1), period: 38, tileW: 76, rate: 0.055, drift: 0, zoomScale: 0, mask: SPINE_MASK },
  { key: 'lat-near', image: latticeTile(114, 0.05, 1.2), period: 114, tileW: 228, rate: 0.16, drift: 0, zoomScale: 0.012, mask: SPINE_MASK },
];

const FIELD_PLANES: Plane[] = [
  { key: 'fld-far', image: moteTile(1337, 300, 4, 0.85, 0.17), period: 300, tileW: 300, rate: 0.05, drift: 1.4, zoomScale: 0, mask: FIELD_MASK },
  { key: 'fld-mid', image: moteTile(4242, 300, 3, 1.3, 0.21), period: 300, tileW: 300, rate: 0.14, drift: 2.6, zoomScale: 0.02, mask: FIELD_MASK },
  { key: 'fld-near', image: moteTile(9001, 300, 2, 2, 0.26), period: 300, tileW: 300, rate: 0.3, drift: 4.2, zoomScale: 0.055, mask: FIELD_MASK },
];

// Film grain over the gradients. Without it the wide, very-low-contrast radials band badly on an
// 8-bit panel — which is exactly the display this thing is meant to live on.
const GRAIN = svgUrl(
  `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/></filter><rect width="180" height="180" filter="url(%23n)"/>`,
  180,
  180,
);

interface Props {
  /** Live fractional focus height, written by the scroller's rAF (never a re-render). */
  focusRef: React.MutableRefObject<number>;
  /** Live velocity zoom, same channel. */
  zoomRef: React.MutableRefObject<number>;
  /**
   * The scene's own `viewportScale`. The backdrop MUST ride it, for two reasons — the second is a
   * correctness one, not a cosmetic one:
   *
   *  - tile size: the lattice is the ground the cubes stand on, so when they shrink it shrinks;
   *  - parallax: the rates are fractions of how far the chain travels per block, and that travel is
   *    itself scaled. Left unscaled, a phone's chain moves 130px per block while the near plane
   *    still moved a desktop 45px — 35% of chain speed instead of 16%. A background gaining on the
   *    foreground inverts the depth cue, and it got worse the narrower the screen.
   *
   * 1 at/above FULL_SCALE_WIDTH, so the desktop render is unchanged.
   */
  scale: number;
  /** @see TILE_SCALE_FLOOR — the tile does NOT ride the scale all the way down. */
  reducedMotion: boolean;
}

function BackdropImpl({ focusRef, zoomRef, scale, reducedMotion }: Props) {
  const mode = useMemo(backdropMode, []);
  const tileScale = Math.max(scale, TILE_SCALE_FLOOR);
  const planes = useMemo<Plane[]>(
    () =>
      mode === 'lattice' ? LATTICE_PLANES
      : mode === 'field' ? FIELD_PLANES
      : mode === 'both' ? [...LATTICE_PLANES, ...FIELD_PLANES]
      : [],
    [mode],
  );

  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    // Reduced motion keeps the depth (the layers, the bloom, the grain) and drops only the movement.
    if (planes.length === 0 || reducedMotion) return;
    let raf = 0;
    const t0 = performance.now();
    // Last values written, so a parked chain costs one comparison per frame and zero style writes.
    const lastY = new Float64Array(planes.length).fill(NaN);
    const lastS = new Float64Array(planes.length).fill(NaN);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const focus = focusRef.current;
      const zoom = zoomRef.current;
      const secs = (now - t0) / 1000;
      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        const el = layerRefs.current[i];
        if (!el) continue;
        // Scrolling toward the tip pulls the world downward past the viewer, so the plane travels
        // with it — at a fraction of the distance, which is the whole depth illusion. Both the
        // travel and the tile ride the scene scale, so the fraction holds at every width. Reduced
        // modulo the RENDERED tile period, the offset never grows and the pattern never jumps.
        const period = p.period * tileScale;
        const raw = focus * PX_PER_HEIGHT * scale * p.rate + secs * p.drift;
        const y = ((raw % period) + period) % period;
        const s = 1 + (zoom - 1) * p.zoomScale;
        if (y === lastY[i] && s === lastS[i]) continue;
        lastY[i] = y;
        lastS[i] = s;
        el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)${p.zoomScale ? ` scale(${s.toFixed(4)})` : ''}`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [planes, scale, tileScale, reducedMotion, focusRef, zoomRef]);

  if (mode === 'off') return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 0 }} aria-hidden>
      {/* Ground: a teal-biased near-black, a shade off the page's neutral black, so the chain
          viewport reads as a lit space and the flanking rails read as chrome over it. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, #040c0b 0%, #030807 46%, #020504 100%)',
        }}
      />

      {/* Parallax planes. Each is a masked window at exactly viewport size holding the tile layer
          that actually moves. Keeping the mask on the window rather than on the moving layer is what
          decouples the two: the mask geometry stays viewport-relative no matter how far a plane has
          to overhang, so changing a tile size can never quietly restyle its fade. */}
      {planes.map((p, i) => (
        <div
          key={p.key}
          className="absolute inset-0 overflow-hidden"
          style={{ maskImage: p.mask, WebkitMaskImage: p.mask }}
        >
          <div
            ref={(el) => {
              layerRefs.current[i] = el;
            }}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: -overhangFor(p.period * tileScale),
              bottom: -overhangFor(p.period * tileScale),
              backgroundImage: p.image,
              backgroundRepeat: 'repeat',
              // Explicit rather than the tile's natural size, so the pattern rides the scene scale.
              // At scale 1 this IS the natural size, leaving the desktop render untouched.
              backgroundSize: `${(p.tileW * tileScale).toFixed(2)}px ${(p.period * tileScale).toFixed(2)}px`,
              willChange: 'transform',
            }}
          />
        </div>
      ))}

      {/* Bloom on the focus anchor — the chain's own light, breathing slowly so a parked tip is
          still alive. Sits above the planes so the lattice reads as lit near the spine. */}
      <div
        className={reducedMotion ? undefined : 'fw-bd-breathe'}
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse 58% 46% at 50% ${(ANCHOR * 100).toFixed(0)}%, rgba(28,191,166,0.055) 0%, rgba(20,120,110,0.02) 42%, transparent 74%)`,
        }}
      />

      {/* Horizon: the ground catching light at the bottom of the tunnel, so deep history has a
          floor to recede toward instead of fading into nothing. */}
      {(mode === 'lattice' || mode === 'both') && (
        <div
          className="absolute inset-x-0 bottom-0 h-1/3"
          style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(28,191,166,0.018) 100%)' }}
        />
      )}

      {/* Vignette, then grain. Grain is last so it sits over every gradient it exists to de-band. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 74% 66% at 50% 44%, transparent 0%, transparent 40%, rgba(0,0,0,0.68) 100%)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{ backgroundImage: GRAIN, backgroundRepeat: 'repeat', opacity: 0.035, mixBlendMode: 'overlay' }}
      />
    </div>
  );
}

/** Memo'd behind stable refs: the chain above re-renders every frame while the focus glides, and
 *  this must sit that out entirely — its own rAF does the work. */
export const Backdrop = memo(BackdropImpl);
