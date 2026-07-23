import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EPOCH, clamp, epochOf } from '../iso';
import { useStore } from '../store';
import type { SignalingInfo } from '../types';
import { clsx, fmtHeight, formatInt, niceStep } from '../util';

/**
 * Left-hand rail: ONE difficulty epoch, zoomed — whichever epoch the chain focus is in. Follow the
 * tip and it shows the live epoch; scroll back into history and it flips to detailing that epoch
 * instead. The mirror of the right ScrollRail — same width, same drag-to-seek — but its vertical
 * span is one epoch [start, retarget) instead of the whole cached chain, so ~2,000 blocks get the
 * pixels the right rail gives ~30,000.
 *
 * That zoom is what makes per-block detail legible: every block that signals bit 4 draws as its own
 * emerald comet at its true height, so the viewer sees not just how much of the epoch signals but
 * WHERE in it the signaling happened. For the LIVE epoch the headline counts come from the
 * backend's own tally (state.signaling, epoch-scoped) — authoritative even before per-block data
 * has streamed in. For a PAST epoch there is no backend tally, so the counts are made from the
 * cached blocks themselves and dim slightly until the whole epoch has loaded.
 *
 * Retarget boundary at the top, epoch start at the bottom; in the live epoch everything above the
 * tip is the unmined remainder, hatched. Dragging seeks the chain focus exactly like the right
 * rail, clamped to the mined stretch of the shown epoch.
 */

// Half the thumb-pill height (plus a hair) reserved at each end so the pill and its labels are
// never clipped at the rail's ends. Matches the right rail.
const PAD = 18;

interface Props {
  tip: number;
  /** Lowest height with cached block data — below it markers cannot be known, so hatch it. */
  dataFloor: number;
  focus: number;
  signaling: SignalingInfo;
  forkHeight: number | null;
  onSeek: (h: number) => void;
}

/** Width of the vertical gauge strip hugging the track's left edge. */
const GAUGE_W = 16;
/** Signal markers and left-anchored labels start just right of the gauge. */
const TRACK_INSET = GAUGE_W + 6;

// memo: the parent (IsometricChain) re-renders on every animation frame while the focus glides,
// but this rail's props only move when the SNAPPED target, the tip or the floor does. Without the
// memo each frame reconciled the whole rail — up to a few thousand tick/marker nodes at 60 Hz.
export const EpochRail = memo(function EpochRail({ tip, dataFloor, focus, signaling, forkHeight, onSeek }: Props) {
  const focusH = Math.round(focus);

  // The epoch being detailed is the FOCUS's epoch, not the tip's.
  const start = Math.floor(clamp(focusH, 0, tip) / EPOCH) * EPOCH;
  const end = start + EPOCH; // first height of the NEXT epoch — the retarget
  const epochHi = Math.min(tip, end - 1); // highest mined height in this epoch
  const isCurrent = tip < end;

  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [railH, setRailH] = useState(600);

  const usable = Math.max(1, railH - 2 * PAD);
  const yFrac = (h: number) => clamp((end - h) / EPOCH, 0, 1);
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
      // Seeks clamp to the MINED stretch of the shown epoch — in the live epoch the hatched
      // remainder has no blocks to focus, and a past epoch is bounded by its own retarget.
      return Math.round(clamp(end - frac * EPOCH, start, epochHi));
    },
    [focus, start, end, epochHi],
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

  // -------- Per-block signal markers --------
  // The store's height-keyed map is the source; this effect makes sure the shown epoch is in it.
  // Debounced, because a long flight across history crosses an epoch boundary every few frames and
  // each crossing would otherwise fire a fresh burst of chunk fetches for an epoch that is already
  // behind us. fetchRange itself skips complete chunks and dedupes in-flight ones.
  const blocksByHeight = useStore((s) => s.blocksByHeight);
  const fetchRange = useStore((s) => s.fetchRange);
  useEffect(() => {
    const t = setTimeout(() => {
      void fetchRange(start, epochHi);
    }, 200);
    return () => clearTimeout(t);
  }, [start, epochHi, fetchRange]);

  const { signalHeights, loadedCount } = useMemo(() => {
    const out: number[] = [];
    let loaded = 0;
    for (let h = Math.max(start, dataFloor); h <= epochHi; h++) {
      const b = blocksByHeight.get(h);
      if (!b) continue;
      loaded++;
      if (b.signals_110) out.push(h);
    }
    return { signalHeights: out, loadedCount: loaded };
  }, [blocksByHeight, start, epochHi, dataFloor]);

  // -------- Headline tally --------
  // Live epoch: the backend's own tally, exact regardless of what the client has cached.
  // Past epoch: counted from the cached blocks — flagged as partial until the epoch is fully in.
  const knowable = Math.max(0, epochHi - Math.max(start, dataFloor) + 1);
  const scanned = isCurrent || loadedCount >= knowable;
  const total = isCurrent
    ? Number.isFinite(signaling?.total)
      ? signaling.total
      : 0
    : epochHi - start + 1;
  const signaled = isCurrent
    ? Number.isFinite(signaling?.signaled)
      ? signaling.signaled
      : 0
    : signalHeights.length;
  const nonSignaled = Math.max(0, total - signaled);
  const pct = isCurrent
    ? Number.isFinite(signaling?.pct)
      ? signaling.pct
      : 0
    : total > 0
      ? (100 * signaled) / total
      : 0;
  const pctNon = total > 0 ? 100 - pct : 0;
  const threshold = Number.isFinite(signaling?.threshold_pct) ? signaling.threshold_pct : 55;
  const met = pct >= threshold;
  // Threshold is a block-count ratio (1109/2016 = 55.00992…%), so trim to one decimal.
  const thresholdLabel = (Math.round(threshold * 10) / 10).toString();
  const partialTitle = scanned ? undefined : 'counted from cached blocks — epoch still loading';

  // Fine height ticks (~one per 30px), skipping the two boundary heights which carry their own
  // labels. The epoch spans 2,016 heights, so these land on round 100s/200s.
  const tickStep = niceStep(EPOCH / Math.max(4, Math.floor(railH / 30)));
  const ticks: number[] = [];
  for (let h = Math.ceil(start / tickStep) * tickStep; h < end; h += tickStep) {
    if (h > start) ticks.push(h);
  }

  // Next signaling block above/below the focus — targets for the jump buttons. signalHeights is
  // ascending, so scan from each end.
  const sigUp = signalHeights.find((h) => h > focusH);
  let sigDown: number | undefined;
  for (let i = signalHeights.length - 1; i >= 0; i--) {
    if (signalHeights[i] < focusH) {
      sigDown = signalHeights[i];
      break;
    }
  }

  // The gauge is the epoch ruler read as a tally: signaled blocks stacked from the epoch start,
  // against the same scale the track uses — so its fill top IS "start + signaled" and the
  // activation threshold is a fixed height on the ruler (1,109 blocks up), not a separate axis.
  const gaugeTopPx = yPx(start + signaled);
  const thresholdH = start + (threshold / 100) * EPOCH;

  return (
    <div className="flex h-full w-[204px] shrink-0 flex-col border-r border-white/10 bg-black/40">
      {/* header: which epoch + the signaling tally it exists to show */}
      <div className="border-b border-white/10 px-2.5 pb-2 pt-2">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">
            Epoch {epochOf(start)}
            {!isCurrent && <span className="ml-1 text-amber-300/70">· past</span>}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-zinc-400">
            {formatInt(total)} / {formatInt(EPOCH)}
          </span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              signaling
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] font-semibold tabular-nums text-emerald-300',
                !scanned && 'opacity-60',
              )}
              title={partialTitle}
            >
              {formatInt(signaled)}
              <span className="ml-1.5 text-emerald-400/60">{pct.toFixed(1)}%</span>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
              non-signaling
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] font-semibold tabular-nums text-zinc-300',
                !scanned && 'opacity-60',
              )}
              title={partialTitle}
            >
              {formatInt(nonSignaled)}
              <span className="ml-1.5 text-zinc-500">{pctNon.toFixed(1)}%</span>
            </span>
          </div>
        </div>

        {/* quick jumps: tip, and the nearest signaling block either side of the focus */}
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={() => onSeek(tip)}
            title="Jump to tip"
            className="flex-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-200 transition hover:bg-emerald-500/20"
          >
            ⤒ Tip
          </button>
          <button
            onClick={() => sigUp != null && onSeek(sigUp)}
            disabled={sigUp == null}
            title={sigUp != null ? `Next signaling block above: ${fmtHeight(sigUp)}` : 'No signaling block above'}
            className={clsx(
              'flex-1 rounded border px-1 py-1 text-[10px] font-bold uppercase tracking-wider transition',
              sigUp != null
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                : 'cursor-default border-white/10 bg-white/[0.03] text-zinc-600',
            )}
          >
            ↑ Sig
          </button>
          <button
            onClick={() => sigDown != null && onSeek(sigDown)}
            disabled={sigDown == null}
            title={sigDown != null ? `Next signaling block below: ${fmtHeight(sigDown)}` : 'No signaling block below'}
            className={clsx(
              'flex-1 rounded border px-1 py-1 text-[10px] font-bold uppercase tracking-wider transition',
              sigDown != null
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                : 'cursor-default border-white/10 bg-white/[0.03] text-zinc-600',
            )}
          >
            ↓ Sig
          </button>
        </div>
      </div>

      {/* rail track — one epoch tall */}
      <div
        ref={railRef}
        className="relative min-h-0 flex-1 cursor-pointer overflow-hidden"
        onPointerDown={(e) => {
          draggingRef.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          onSeek(heightFromClientY(e.clientY));
        }}
      >
        {/* unmined remainder of the LIVE epoch: everything above the tip, hatched. A past epoch is
            fully mined, so it has none. */}
        {isCurrent && (
          <div
            className="pointer-events-none absolute inset-x-0"
            style={{ top: `${yPx(end)}px`, height: `${yPx(tip) - yPx(end)}px` }}
          >
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, rgba(148,163,184,0.05) 0, rgba(148,163,184,0.05) 5px, transparent 5px, transparent 11px)',
              }}
            />
            <div className="absolute inset-x-0 bottom-0 h-px bg-emerald-400/60" />
          </div>
        )}

        {/* not-yet-cached region: [start, dataFloor) — markers unknowable there */}
        {dataFloor > start && (
          <div
            className="pointer-events-none absolute inset-x-0"
            style={{ top: `${yPx(Math.min(dataFloor, end))}px`, height: `${yPx(start) - yPx(Math.min(dataFloor, end))}px` }}
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
              not cached
            </span>
          </div>
        )}

        {/* gauge body spans EXACTLY the ruler's mapped range [yPx(end), yPx(start)], so the fill
            meets its ends flush — no orphan strip in the rail's padding zones. The rung texture
            makes it read as a thermometer, not another background band. */}
        <div
          className="pointer-events-none absolute left-0 border-x border-white/15 bg-black/60"
          style={{
            width: GAUGE_W,
            top: `${yPx(end)}px`,
            height: `${yPx(start) - yPx(end)}px`,
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(148,163,184,0.13) 0 1px, transparent 1px 5px)',
          }}
        />
        <div
          className={clsx(
            'pointer-events-none absolute transition-all duration-500',
            met ? 'bg-emerald-400/80' : 'bg-amber-400/80',
          )}
          style={{
            left: 1,
            width: GAUGE_W - 2,
            top: `${gaugeTopPx}px`,
            height: `${yPx(start) - gaugeTopPx}px`,
            boxShadow: met
              ? '0 0 10px 1px rgba(52,211,153,0.35)'
              : '0 0 10px 1px rgba(251,191,36,0.3)',
          }}
          title={`${formatInt(signaled)} signaling blocks of the ${formatInt(EPOCH)} this epoch holds`}
        />
        <div
          className="pointer-events-none absolute left-0 flex -translate-y-1/2 items-center gap-1"
          style={{ top: `${yPx(thresholdH)}px` }}
          title={`activation threshold ${thresholdLabel}% — the fill must reach this line`}
        >
          <span className="h-[2px] bg-zinc-200" style={{ width: GAUGE_W }} />
          <span className="font-mono text-[8px] uppercase text-zinc-500">th</span>
        </div>

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

        {/* one comet per signaling block — a bright head at the gauge, tail streaking toward the
            chain. WHERE in the epoch the signaling is. */}
        {signalHeights.map((h) => (
          <div
            key={`s${h}`}
            className="pointer-events-none absolute flex -translate-y-1/2 items-center"
            style={{ top: `${yPx(h)}px`, left: TRACK_INSET }}
            title={`${fmtHeight(h)} signals bit 4`}
          >
            <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-emerald-300 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]" />
            <span
              className="h-[2px] w-[64px] rounded-r-full"
              style={{
                background:
                  'linear-gradient(90deg, rgba(110,231,183,0.9), rgba(52,211,153,0.35) 55%, transparent)',
              }}
            />
          </div>
        ))}

        {/* retarget boundary — the top of this rail's world */}
        <div
          className="pointer-events-none absolute inset-x-0 -translate-y-1/2"
          style={{ top: `${yPx(end)}px` }}
        >
          <div className="h-px w-full bg-amber-300/35" />
          <span
            className="absolute top-1 rounded-sm bg-black/55 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-amber-300/80 backdrop-blur"
            style={{ left: TRACK_INSET }}
          >
            retarget · {fmtHeight(end)}
          </span>
        </div>

        {/* dashed fork marker, if the split sits inside this epoch */}
        {forkHeight != null && forkHeight >= start && forkHeight < end && (
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

        {/* focus thumb — same handle as the right rail. The shown epoch always contains the focus
            (it is derived from it), so the thumb is always present. */}
        <div
          className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2"
          style={{ top: `${yPx(clamp(focus, start, epochHi))}px` }}
        >
          <div className="h-px w-full bg-gradient-to-l from-transparent via-cyan-300/80 to-cyan-200" />
          <div className="absolute right-0 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(103,232,249,0.7)]" />
          <div
            className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md border border-cyan-300/50 bg-cyan-500/15 px-1.5 py-1 backdrop-blur"
            style={{ left: TRACK_INSET }}
          >
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

      {/* epoch-start footer */}
      <div className="border-t border-white/10 px-2 py-1 text-center">
        <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">
          start {fmtHeight(start)}
        </span>
      </div>
    </div>
  );
});
