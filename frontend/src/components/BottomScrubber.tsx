import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EPOCH, clamp } from '../iso';
import { fmtHeight } from '../util';

interface Props {
  tip: number;
  /** Display floor — left end of the track. */
  floor: number;
  /** Data floor — [floor, dataFloor) is history not yet cached; hatched. */
  dataFloor: number;
  focus: number;
  forkHeight: number | null;
  onSeek: (h: number) => void;
  onTip: () => void;
  onFork: () => void;
}

/**
 * Phone-only navigation: the vertical {@link ScrollRail} laid on its side as a bottom bar. Oldest
 * (floor) at the left, tip at the right; drag the track to seek, tap the end buttons to jump. It
 * carries the same seek math as the rail — height ↔ fractional position — just rotated to X, so a
 * phone gets the full range of the chain in a control that costs one row instead of a 204px column.
 */
const PAD = 14;

export const BottomScrubber = memo(function BottomScrubber({
  tip,
  floor,
  dataFloor,
  focus,
  forkHeight,
  onSeek,
  onTip,
  onFork,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [trackW, setTrackW] = useState(320);
  const range = Math.max(1, tip - floor);
  const usable = Math.max(1, trackW - 2 * PAD);

  const xFrac = (h: number) => clamp((h - floor) / range, 0, 1);
  const xPx = (h: number) => PAD + xFrac(h) * usable;

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || 320));
    ro.observe(el);
    setTrackW(el.clientWidth || 320);
    return () => ro.disconnect();
  }, []);

  const heightFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return focus;
      const rect = el.getBoundingClientRect();
      const span = Math.max(1, rect.width - 2 * PAD);
      const frac = clamp((clientX - rect.left - PAD) / span, 0, 1);
      return Math.round(floor + frac * range);
    },
    [focus, floor, range],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      onSeek(heightFromClientX(e.clientX));
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [heightFromClientX, onSeek]);

  // Sparse epoch ticks — enough to give the track a sense of scale without crowding a phone width.
  const epochs: number[] = [];
  for (let h = Math.ceil(floor / EPOCH) * EPOCH; h <= tip; h += EPOCH) epochs.push(h);
  const maxTicks = Math.max(2, Math.floor(trackW / 60));
  const stride = Math.max(1, Math.ceil(epochs.length / maxTicks));
  const epochTicks = epochs.filter((_, i) => i % stride === 0);

  const focusH = Math.round(focus);

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-black/60 px-3 py-2 backdrop-blur">
      <button
        onClick={onTip}
        title="Jump to tip"
        aria-label="Jump to tip"
        className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-200 transition active:bg-emerald-500/25"
      >
        Tip
      </button>
      {forkHeight != null && (
        <button
          onClick={onFork}
          title={`Jump to fork at ${fmtHeight(forkHeight)}`}
          aria-label="Jump to fork"
          className="shrink-0 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-red-200 transition active:bg-red-500/25"
        >
          Fork
        </button>
      )}

      {/* the track: floor (left) → tip (right) */}
      <div
        ref={trackRef}
        className="relative h-9 flex-1 cursor-pointer touch-none select-none"
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          onSeek(heightFromClientX(e.clientX));
        }}
      >
        {/* base line */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/12" />

        {/* not-yet-cached region [floor, dataFloor) */}
        {dataFloor > floor && (
          <div
            className="pointer-events-none absolute top-1/2 h-4 -translate-y-1/2"
            style={{
              left: `${xPx(floor)}px`,
              width: `${xPx(dataFloor) - xPx(floor)}px`,
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0, rgba(148,163,184,0.10) 4px, transparent 4px, transparent 9px)',
            }}
          />
        )}

        {/* epoch ticks */}
        {epochTicks.map((h) => (
          <div
            key={`e${h}`}
            className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-amber-300/35"
            style={{ left: `${xPx(h)}px` }}
          />
        ))}

        {/* fork marker */}
        {forkHeight != null && (
          <div
            className="pointer-events-none absolute top-1/2 h-5 w-px -translate-y-1/2 bg-red-400/70"
            style={{ left: `${xPx(forkHeight)}px` }}
          />
        )}

        {/* focus thumb */}
        <div
          className="pointer-events-none absolute top-1/2 -translate-y-1/2"
          style={{ left: `${xPx(focus)}px` }}
        >
          <div className="absolute top-1/2 h-6 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-cyan-300/80" />
          <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.7)]"
            style={{ height: 12, width: 12 }} />
        </div>
      </div>

      <span className="w-16 shrink-0 text-right font-mono text-[11px] font-bold tabular-nums text-cyan-100">
        {fmtHeight(focusH)}
      </span>
    </div>
  );
});
