import { useMemo, useRef } from 'react';
import { estimateEta, estimateRate } from '../eta';
import type { EtaEstimate, PacingModel, RateEstimate } from '../eta';
import { useNow } from '../hooks/useNow';
import { useStore } from '../store';
import type { ChainState, NodeInfo, Side } from '../types';
import { clsx, formatInt } from '../util';
import { SegmentClock, SegmentNumber } from './SegmentClock';

/**
 * Below this many blocks the clock is retired: a time estimate over a handful of blocks is mostly
 * noise (the variance of a Poisson sum is dominated by its last few terms), and the block count is
 * the honest number to watch at that point.
 */
const CLOCK_RETIRES_AT_BLOCKS = 21;

/**
 * How often the arrival estimate is re-derived, in blocks. The difficulty epoch (2016) is a multiple
 * of 72, so bucketing height by 72 puts the first refresh of every epoch exactly on the retarget and
 * spaces the other 27 evenly through it.
 *
 * Between checkpoints the predicted arrival *instant* is held fixed and the clock simply counts down
 * to it, so the display only ever moves one way. Re-estimating on every block instead made it twitch
 * by that block's deviation from the mean interval — minutes at a time, in either direction, on a
 * chain that is behaving perfectly normally. That is noise, not news; absorbing it at 28 discrete
 * points per epoch keeps the estimate current without making it unwatchable.
 */
const RECALC_EVERY_BLOCKS = 72;

/** A held ETA: the estimate, plus its mean and 80% bounds pinned to absolute wall-clock times. */
interface EtaSnapshot {
  eta: EtaEstimate;
  targetMs: number;
  loMs: number;
  hiMs: number;
}

/**
 * The ETA, recomputed only when the tip crosses a `RECALC_EVERY_BLOCKS` boundary (or the target
 * moves), and pinned to absolute times so it stops depending on when it is read.
 *
 * The pacing model is sampled at the same moments. `blocksAtCurrentDifficulty` shrinks with every
 * block, but the retarget it counts down to lands on a multiple of 2016 — and therefore of 72 — so
 * the epoch always turns over on a checkpoint rather than between two.
 */
function useHeldEta(
  rate: RateEstimate | null,
  blocks: number | null,
  pacing: PacingModel | null,
  targetHeight: number | null,
  now: number,
): EtaSnapshot | null {
  const held = useRef<{ bucket: number; target: number | null; snap: EtaSnapshot } | null>(null);

  if (!rate || blocks == null || blocks <= 0) {
    // Nothing to count down to. Drop the snapshot so a later target cannot inherit these numbers.
    held.current = null;
    return null;
  }

  const bucket = Math.floor(rate.lastHeight / RECALC_EVERY_BLOCKS);
  const prev = held.current;
  if (prev && prev.bucket === bucket && prev.target === targetHeight) return prev.snap;

  const eta = estimateEta(rate, blocks, pacing);
  // A checkpoint that cannot produce an estimate keeps the previous one rather than blanking the
  // clock; the next block will try again.
  if (!eta) return prev?.snap ?? null;

  // Anchor on the tip's timestamp so the countdown reflects time already elapsed since it, clamped
  // to now because a header timestamp may legitimately sit up to two hours in the future.
  const anchorMs = Math.min(eta.lastTime * 1000, now);
  const snap: EtaSnapshot = {
    eta,
    targetMs: anchorMs + eta.seconds * 1000,
    loMs: anchorMs + eta.lo * 1000,
    hiMs: anchorMs + eta.hi * 1000,
  };
  held.current = { bucket, target: targetHeight, snap };
  return snap;
}

type Tone = 'amber' | 'red' | 'sky' | 'emerald';

const TONE: Record<Tone, { text: string; dim: string }> = {
  amber: { text: 'text-amber-300', dim: 'text-amber-400/70' },
  red: { text: 'text-red-400', dim: 'text-red-400/70' },
  sky: { text: 'text-sky-300', dim: 'text-sky-400/70' },
  emerald: { text: 'text-emerald-300', dim: 'text-emerald-400/70' },
};

function Brand() {
  return (
    <span className="select-none text-xl font-black leading-none tracking-tight text-zinc-100 sm:text-2xl">
      FORK<span className="text-emerald-400">WATCH</span>
    </span>
  );
}

function NodeReadout({ node, side }: { node: NodeInfo; side: Side }) {
  const stance = side === 'knots' ? 'SIGNALING' : 'NON-SIGNALING';
  return (
    <div data-side={side} className="flex items-center gap-2" title={node.version}>
      <span
        className={clsx(
          'h-2 w-2 shrink-0 rounded-full',
          node.online ? 'bg-emerald-400 shadow-[0_0_6px_1px_rgba(52,211,153,0.5)]' : 'bg-red-500',
        )}
        title={node.online ? 'online' : 'offline'}
      />
      <div className="leading-tight">
        <div
          className={clsx(
            'text-[10px] font-bold uppercase tracking-wider',
            side === 'core' ? 'text-zinc-300' : 'text-emerald-300',
          )}
        >
          {stance}
        </div>
        <div className="text-[9px] text-zinc-600">{node.version}</div>
      </div>
      <div className="font-mono text-sm font-bold tabular-nums leading-none text-zinc-100">
        {formatInt(node.blocks)}
      </div>
    </div>
  );
}

/** A plain status headline — used for every state that is not the countdown. */
interface StatusHero {
  kind: 'status';
  tone: Tone;
  value: string;
  unit?: string;
  eyebrow: string;
  caption: string;
  pulse?: string;
}

/** The countdown to the target height. Carries both faces so they can cross-fade. */
interface CountdownHero {
  kind: 'countdown';
  tone: Tone;
  eyebrow: string;
  caption: string;
  blocks: number;
  /** Seconds remaining, or null when there is no usable rate estimate yet. */
  seconds: number | null;
  /**
   * Which face to show. `pending` means the rate sample has not arrived yet — both faces stay
   * hidden, because guessing would flash the block count for a frame before the clock takes over.
   */
  face: 'clock' | 'blocks' | 'pending';
  pulse: string;
}

type Hero = StatusHero | CountdownHero;

function useHero(state: ChainState | null): Hero | null {
  const recentBlocks = useStore((s) => s.recentBlocks);
  const recentLoaded = useStore((s) => s.recentLoaded);
  const now = useNow(1000);
  const rate = useMemo(() => estimateRate(recentBlocks), [recentBlocks]);

  // Countdown inputs, hoisted above the branches below because the held ETA is a hook and so cannot
  // sit inside the `sf && !sf.reached` arm where it is actually used.
  const sf = state?.scheduled_fork ?? null;
  const blocksUntil = sf && !sf.reached ? sf.blocks_until : null;
  // How many of those blocks are still mined under today's difficulty. A block's difficulty comes
  // from its epoch, and `next_retarget_height` is the first height of the next one — so the last
  // block at the current difficulty is the one below it, hence the -1.
  const pacing =
    state?.pacing?.target_spacing && state.pacing.next_retarget_height != null
      ? {
          blocksAtCurrentDifficulty: Math.max(
            0,
            state.pacing.next_retarget_height - (state.tip_height ?? 0) - 1,
          ),
          targetSpacing: state.pacing.target_spacing,
        }
      : null;
  const snapshot = useHeldEta(rate, blocksUntil, pacing, sf?.height ?? null, now);

  if (!state) return null;

  // A SPLIT is two competing blocks at the same height — the thing this whole app exists to show.
  if (state.split) {
    const at = state.fork?.at_height ?? state.lca_height ?? 0;
    const coreAhead = Math.max(0, (state.core?.blocks ?? 0) - at);
    const knotsAhead = Math.max(0, (state.knots?.blocks ?? 0) - at);
    return {
      kind: 'status',
      tone: 'red',
      value: `+${formatInt(coreAhead)} / +${formatInt(knotsAhead)}`,
      eyebrow: `Chain split at #${formatInt(at)}`,
      caption: `non-signaling +${formatInt(coreAhead)} · signaling +${formatInt(knotsAhead)} — blocks mined on each branch since the split`,
      pulse: `${coreAhead}:${knotsAhead}`,
    };
  }

  // Knots has rejected Core's tip but has not yet mined a rival block at that height. The chains are
  // already irreconcilable, so this is emphatically not "syncing" — but it is not yet a split.
  if (state.rejected) {
    return {
      kind: 'status',
      tone: 'amber',
      value: 'REJECTED',
      eyebrow: 'Knots rejected the tip',
      caption: `non-signaling #${formatInt(state.core?.blocks)} · signaling #${formatInt(state.knots?.blocks)} — no competing block at that height yet`,
    };
  }

  if (state.syncing) {
    return {
      kind: 'status',
      tone: 'sky',
      value: 'SYNCING',
      eyebrow: 'Nodes catching up',
      caption: `non-signaling #${formatInt(state.core?.blocks)} · signaling #${formatInt(state.knots?.blocks)} — one node behind, not a split`,
    };
  }

  // Counting down to the target height.
  if (sf && !sf.reached) {
    const n = sf.blocks_until;
    const label = (sf.label ?? 'Scheduled fork').toUpperCase();

    // Counts down to a fixed instant. The clock therefore ticks purely off `now` and stays still on
    // block arrivals — the estimate itself only moves at a 72-block checkpoint.
    const seconds = snapshot ? (snapshot.targetMs - now) / 1000 : null;

    const face: CountdownHero['face'] = !recentLoaded
      ? 'pending'
      : n > CLOCK_RETIRES_AT_BLOCKS && seconds != null && seconds > 0
        ? 'clock'
        : 'blocks';

    // Rendered in the viewer's own locale and timezone: passing `undefined` as the locale takes the
    // browser's, and omitting `timeZone` takes its local zone.
    const etaDate =
      snapshot && seconds != null && seconds > 0
        ? new Date(snapshot.targetMs).toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null;

    return {
      kind: 'countdown',
      tone: 'amber',
      // The arrival time is the headline above the clock — the unit a viewer actually plans around.
      // Falls back to naming the target height when there is no rate estimate to date it with.
      eyebrow: etaDate ?? `${label} · #${formatInt(sf.height)}`,
      // Just the distance to the target. The band, the rate and the retarget split were all true and
      // all noise: they moved on their own, none of them changed what a viewer would do, and they
      // buried the one number that does. Under the block face even this is redundant with the digits
      // above it, so it goes.
      caption:
        face === 'clock' ? `${formatInt(n)} block${n === 1 ? '' : 's'} to go` : '',
      blocks: n,
      seconds,
      face,
      pulse: String(rate?.lastHeight ?? n),
    };
  }

  // Target passed, or none configured (the countdown simply is not applicable).
  return {
    kind: 'status',
    tone: 'emerald',
    value: 'IN AGREEMENT',
    eyebrow: sf ? `Past #${formatInt(sf.height)}` : 'Single chain',
    caption: `both nodes on the same tip · #${formatInt(state.tip_height)}`,
  };
}

function HeroBlock({ hero }: { hero: Hero }) {
  const tone = TONE[hero.tone];

  return (
    <div className="py-1.5 text-center">
      <div className={clsx('text-[10px] font-bold uppercase tracking-[0.25em]', tone.dim)}>
        {hero.eyebrow}
      </div>

      {hero.kind === 'countdown' ? (
        // Both faces are mounted in the same grid cell so the swap at the retirement mark is a true
        // cross-fade rather than a jump. The clock keeps ticking underneath while faded out.
        <div className="mt-2 grid justify-items-center">
          <div
            className={clsx(
              'col-start-1 row-start-1 transition-opacity duration-700',
              hero.face === 'clock' ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            aria-hidden={hero.face !== 'clock'}
          >
            <SegmentClock seconds={hero.seconds ?? 0} className={tone.text} />
          </div>
          <div
            className={clsx(
              'col-start-1 row-start-1 self-center transition-opacity duration-700',
              hero.face === 'blocks' ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            aria-hidden={hero.face !== 'blocks'}
          >
            <SegmentNumber
              value={hero.blocks}
              label={hero.blocks === 1 ? 'block' : 'blocks'}
              className={tone.text}
            />
          </div>
        </div>
      ) : (
        <div
          key={hero.pulse}
          className="fw-hero-in mt-1.5 flex items-baseline justify-center gap-2 leading-none"
        >
          <span
            className={clsx(
              'font-mono text-4xl font-black tracking-tight sm:text-5xl',
              tone.text,
              'drop-shadow-[0_0_24px_currentColor]',
            )}
          >
            {hero.value}
          </span>
          {hero.unit && (
            <span className={clsx('text-lg font-bold uppercase tracking-widest', tone.dim)}>
              {hero.unit}
            </span>
          )}
        </div>
      )}

      {hero.caption && <div className="mt-2 text-[11px] text-zinc-500">{hero.caption}</div>}
    </div>
  );
}

interface Props {
  state: ChainState | null;
  error: string | null;
}

export function Header({ state, error }: Props) {
  const hero = useHero(state);

  if (!state || !hero) {
    return (
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/70 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Brand />
          <span className="text-sm text-zinc-500">
            {error ? `Connection error: ${error}` : 'Connecting to nodes…'}
          </span>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/70 backdrop-blur">
      <div className="mx-auto max-w-6xl px-5 py-2.5">
        {/* Identity + node liveness — context rather than headline. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Brand />
          <div className="flex items-center gap-4">
            <NodeReadout node={state.core} side="core" />
            <span className="h-6 w-px bg-white/10" />
            <NodeReadout node={state.knots} side="knots" />
          </div>
        </div>

        <HeroBlock hero={hero} />

        {error && (
          <div className="mt-1.5 text-center text-[10px] text-amber-400/80">
            Live update issue: {error} — retrying…
          </div>
        )}
      </div>
    </header>
  );
}
