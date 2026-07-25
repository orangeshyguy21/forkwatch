import { memo } from 'react';
import { CAMERA_LEVELS, CAMERA_MAX_LEVEL, CAMERA_MIN_LEVEL } from '../iso';
import { clsx } from '../util';

/**
 * The camera-distance control: ＋ / − around a stack of detent pips, pinned bottom-right of the chain
 * viewport (clear of the HUD top-right, the epoch chip top-left, and the phone's bottom scrubber,
 * which sits outside this box).
 *
 * The pips ARE the readout — they fill downward as you pull back, so the current distance and how
 * much travel is left both read without a number. Per [[ui-keep-it-lean]] there is no "0.4×" label
 * on the face; that string lives in the buttons' tooltips, where it disambiguates without competing.
 */
function ZoomControlImpl({
  level,
  onStep,
  compact,
}: {
  /** The detent being eased toward (not the eased value — the pips must not stutter mid-transition). */
  level: number;
  onStep: (delta: number) => void;
  /** Touch tier: bigger hit targets. */
  compact?: boolean;
}) {
  const atNear = level <= CAMERA_MIN_LEVEL;
  const atFar = level >= CAMERA_MAX_LEVEL;
  const btn = clsx(
    'grid place-items-center rounded-md font-mono leading-none transition',
    compact ? 'h-9 w-9 text-lg' : 'h-7 w-8 text-base',
    'text-zinc-200 hover:bg-emerald-400/15 hover:text-emerald-300 active:bg-emerald-400/25',
    'disabled:text-zinc-600 disabled:hover:bg-transparent disabled:hover:text-zinc-600',
  );

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-[3200] flex items-end gap-2">
      <div
        className="pointer-events-auto flex flex-col items-center gap-1 rounded-xl border border-white/10 bg-black/55 p-1.5 backdrop-blur"
        role="group"
        aria-label="Camera zoom"
      >
        <button
          onClick={() => onStep(-1)}
          disabled={atNear}
          className={btn}
          title={atNear ? 'Closest view' : `Zoom in to ${CAMERA_LEVELS[level - 1]?.label}`}
          aria-label="Zoom in"
        >
          +
        </button>
        <div className="flex flex-col gap-1 py-0.5" aria-hidden="true">
          {CAMERA_LEVELS.map((_, i) => (
            <span
              key={i}
              className={clsx(
                'h-[3px] w-3.5 rounded-sm transition-colors',
                i <= level ? 'bg-emerald-400' : 'bg-white/20',
              )}
            />
          ))}
        </div>
        <button
          onClick={() => onStep(1)}
          disabled={atFar}
          className={btn}
          title={atFar ? 'Furthest view' : `Zoom out to ${CAMERA_LEVELS[level + 1]?.label}`}
          aria-label="Zoom out"
        >
          −
        </button>
      </div>
    </div>
  );
}

export const ZoomControl = memo(ZoomControlImpl);
