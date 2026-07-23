import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EPOCH, clamp, epochOf } from '../iso';
import { clsx, fmtHeight, niceStep } from '../util';

interface Props {
  tip: number;
  /** Display floor — bottom of the rail; epochs/bands span [floor, tip]. May be below `dataFloor`. */
  floor: number;
  /** Data floor — lowest height with cached block data. [floor, dataFloor) renders as "not cached". */
  dataFloor: number;
  focus: number;
  forkHeight: number | null;
  onSeek: (h: number) => void;
  onTip: () => void;
  onFork: () => void;
}

/**
 * Right-hand navigation timeline. A tall, wide rail: difficulty epochs render as
 * full-width divider lines (labelled on the left) with alternating background
 * bands between them, finer height ticks on the right, a dashed fork marker, and
 * a labelled draggable thumb. Tip is at the top, prune floor at the bottom.
 */
// Half the thumb-pill height (plus a hair) reserved at each end so the pill and
// its label are never clipped by the buttons above or the floor footer below.
const PAD = 18;

// memo: the parent (IsometricChain) re-renders on every animation frame while the focus glides,
// but this rail's props only move when the SNAPPED target, the tip or the floor does. Without the
// memo each frame reconciled the whole rail — up to a few thousand tick/marker nodes at 60 Hz.
export const ScrollRail = memo(function ScrollRail({ tip, floor, dataFloor, focus, forkHeight, onSeek, onTip, onFork }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [railH, setRailH] = useState(600);
  const range = Math.max(1, tip - floor);

  // Usable vertical span, inset by PAD top+bottom. Map heights into [PAD, railH-PAD].
  const usable = Math.max(1, railH - 2 * PAD);
  const yFrac = (h: number) => clamp((tip - h) / range, 0, 1);
  const yPx = (h: number) => PAD + yFrac(h) * usable;

  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRailH(el.clientHeight || 600));
    ro.observe(el);
    setRailH(el.clientHeight || 600);
    return () => ro.disconnect();
  }, []);

  const heightFromClientY = useCallback(
    (clientY: number): number => {
      const el = railRef.current;
      if (!el) return focus;
      const rect = el.getBoundingClientRect();
      const span = Math.max(1, rect.height - 2 * PAD);
      const frac = clamp((clientY - rect.top - PAD) / span, 0, 1);
      return Math.round(tip - frac * range);
    },
    [focus, range, tip],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      onSeek(heightFromClientY(e.clientY));
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
  }, [heightFromClientY, onSeek]);

  // --- Difficulty epochs: full boundary list, then stride so labels don't collide.
  const epochs: number[] = [];
  const firstEpoch = Math.ceil(floor / EPOCH) * EPOCH;
  for (let h = firstEpoch; h <= tip; h += EPOCH) epochs.push(h);
  const maxLabels = Math.max(2, Math.floor(railH / 34));
  const stride = Math.max(1, Math.ceil(epochs.length / maxLabels));
  const epochLines = epochs.filter((_, i) => i % stride === 0);

  // Alternating bands between consecutive drawn epoch lines (plus the ragged ends).
  const edges = [floor, ...epochLines.filter((h) => h > floor && h < tip), tip];
  const bands: { top: number; height: number; shade: boolean }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const top = yPx(edges[i + 1]);
    const bottom = yPx(edges[i]);
    bands.push({ top, height: bottom - top, shade: i % 2 === 0 });
  }

  // --- Finer height ticks (~ one per 30px), skipping any on an epoch boundary.
  const targetTicks = Math.max(4, Math.floor(railH / 30));
  const tickStep = niceStep(range / targetTicks);
  const ticks: number[] = [];
  for (let h = Math.ceil(floor / tickStep) * tickStep; h <= tip; h += tickStep) {
    if (h % EPOCH !== 0) ticks.push(h);
  }

  const focusH = Math.round(focus);

  return (
    <div className="flex h-full w-[204px] shrink-0 flex-col border-l border-white/10 bg-black/40">
      {/* header: label + tip + quick jumps (full width) */}
      <div className="border-b border-white/10 px-2.5 pb-2 pt-2">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">
            Timeline
          </span>
          <span className="font-mono text-[10px] tabular-nums text-zinc-400">{fmtHeight(tip)}</span>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onTip}
            title="Jump to tip"
            className="flex-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-200 transition hover:bg-emerald-500/20"
          >
            ⤒ Tip
          </button>
          {forkHeight != null && (
            <button
              onClick={onFork}
              title={`Jump to fork at ${fmtHeight(forkHeight)}`}
              className="flex-1 rounded border border-red-500/30 bg-red-500/10 px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-red-200 transition hover:bg-red-500/20"
            >
              ⑂ Fork
            </button>
          )}
        </div>
      </div>

      {/* gutter (epoch labels) + track */}
      <div className="flex min-h-0 flex-1">
        {/* left label gutter — epoch text lives here so it never overlaps the track */}
        <div className="relative w-[64px] shrink-0 border-r border-white/5">
          {epochLines.map((h) => (
            <div
              key={`g${h}`}
              className="pointer-events-none absolute right-0 -translate-y-1/2 pr-2 text-right leading-none"
              style={{ top: `${yPx(h)}px` }}
            >
              <div className="font-mono text-[9.5px] font-bold tabular-nums text-amber-300/90">
                epoch {epochOf(h)}
              </div>
              <div className="mt-0.5 font-mono text-[8.5px] tabular-nums text-amber-200/45">
                {fmtHeight(h)}
              </div>
              <span className="absolute right-0 top-1/2 h-px w-1.5 -translate-y-1/2 bg-amber-300/50" />
            </div>
          ))}
        </div>

        {/* rail track */}
        <div
          ref={railRef}
          className="relative flex-1 cursor-pointer overflow-hidden"
          onPointerDown={(e) => {
            draggingRef.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            onSeek(heightFromClientY(e.clientY));
          }}
        >
          {/* alternating epoch bands */}
          {bands.map((b, i) => (
            <div
              key={`b${i}`}
              className={clsx('pointer-events-none absolute inset-x-0', b.shade ? 'bg-white/[0.035]' : 'bg-transparent')}
              style={{ top: `${b.top}px`, height: `${b.height}px` }}
            />
          ))}

          {/* not-yet-cached (node-pruned) region: [floor, dataFloor). Diagonal hatch + a dashed
              boundary at the data floor, so the epoch structure below the live window reads as
              "history not loaded yet" rather than empty/broken. */}
          {dataFloor > floor && (
            <div
              className="pointer-events-none absolute inset-x-0"
              style={{ top: `${yPx(dataFloor)}px`, height: `${yPx(floor) - yPx(dataFloor)}px` }}
            >
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(45deg, rgba(148,163,184,0.05) 0, rgba(148,163,184,0.05) 5px, transparent 5px, transparent 11px)',
                }}
              />
              <div className="absolute inset-x-0 top-0 h-px border-t border-dashed border-amber-300/45" />
              <span className="absolute right-1 top-1 rounded-sm bg-black/55 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-zinc-500 backdrop-blur">
                pruned · not cached
              </span>
            </div>
          )}

          {/* fine height ticks (right side, light) */}
          {ticks.map((h) => (
            <div
              key={`t${h}`}
              className="pointer-events-none absolute right-0 flex -translate-y-1/2 items-center justify-end gap-1"
              style={{ top: `${yPx(h)}px` }}
            >
              <span className="font-mono text-[8px] tabular-nums text-zinc-600">{fmtHeight(h)}</span>
              <span className="h-px w-2 bg-white/15" />
            </div>
          ))}

          {/* epoch divider lines (full-width; text is in the gutter) */}
          {epochLines.map((h) => (
            <div
              key={`e${h}`}
              className="pointer-events-none absolute inset-x-0 h-px -translate-y-1/2 bg-amber-300/35"
              style={{ top: `${yPx(h)}px` }}
              title={`epoch ${epochOf(h)} · ${fmtHeight(h)}`}
            />
          ))}

          {/* dashed fork marker */}
          {forkHeight != null && (
            <div
              className="pointer-events-none absolute inset-x-0 -translate-y-1/2"
              style={{ top: `${yPx(forkHeight)}px` }}
            >
              <div className="h-0 w-full border-t border-dashed border-red-400/70" />
              <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm bg-red-500/20 px-1 py-px font-mono text-[8px] font-bold tabular-nums text-red-200">
                ⑂ fork
              </span>
            </div>
          )}

          {/* focus thumb: full-width indicator line + draggable labelled handle */}
          <div
            className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2"
            style={{ top: `${yPx(focus)}px` }}
          >
            <div className="h-px w-full bg-gradient-to-r from-transparent via-cyan-300/80 to-cyan-200" />
            <div className="absolute left-0 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.7)]" />
            <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md border border-cyan-300/50 bg-cyan-500/15 px-1.5 py-1 backdrop-blur">
              <span className="flex flex-col gap-[2px]">
                <span className="h-px w-2 bg-cyan-200/70" />
                <span className="h-px w-2 bg-cyan-200/70" />
                <span className="h-px w-2 bg-cyan-200/70" />
              </span>
              <span className="font-mono text-[11px] font-bold tabular-nums text-cyan-100">
                {fmtHeight(focusH)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* floor footer */}
      <div className="border-t border-white/10 px-2 py-1 text-center">
        <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">
          floor {fmtHeight(floor)}
        </span>
      </div>
    </div>
  );
});
