import { useMemo, useRef } from 'react';
import { estimateEta, estimateRate } from '../eta';
import type { EtaEstimate, PacingModel, RateEstimate } from '../eta';
import { useNow } from '../hooks/useNow';
import { useStore } from '../store';
import type { ChainState, NodeInfo, Side } from '../types';
import { clsx, fmtHeight, formatInt } from '../util';
import { RaceRail } from './RaceRail';
import { SegmentBar, SegmentClock, SegmentNumber } from './SegmentClock';

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

/** A held ETA: the estimate, plus its predicted arrival pinned to an absolute wall-clock time. */
interface EtaSnapshot {
  eta: EtaEstimate;
  targetMs: number;
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
  const snap: EtaSnapshot = { eta, targetMs: anchorMs + eta.seconds * 1000 };
  held.current = { bucket, target: targetHeight, snap };
  return snap;
}

/** Public source repository — the GitHub mark in the header links here. */
const REPO_URL = 'https://github.com/orangeshyguy21/forkwatch';

/** Wordmark. Lives pinned to the header's far-left edge, vertically centred over the full bar. */
function Brand() {
  return (
    <span className="select-none text-xl font-black leading-none tracking-tight text-zinc-100 sm:text-2xl">
      FORK<span className="text-emerald-400">WATCH</span>
    </span>
  );
}

/** GitHub mark → the open-source repo. Pinned to the header's far-right edge, vertically centred. */
function GithubLink() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      title="View the source on GitHub"
      aria-label="View the source on GitHub"
      className="text-zinc-500 transition-colors hover:text-zinc-100"
    >
      <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden="true">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    </a>
  );
}

type Tone = 'amber' | 'red' | 'sky' | 'emerald';

const TONE: Record<Tone, { text: string; dim: string }> = {
  amber: { text: 'text-amber-300', dim: 'text-amber-400/70' },
  red: { text: 'text-red-400', dim: 'text-red-400/70' },
  sky: { text: 'text-sky-300', dim: 'text-sky-400/70' },
  emerald: { text: 'text-emerald-300', dim: 'text-emerald-400/70' },
};

/** Per-node tone + delta for the flanking readouts, derived from the same state branches the hero
 *  uses. Colours track the race rail below: cyan/slate lanes on a split, sky for a lagging node,
 *  amber for a rejected tip, quiet zinc when there is nothing to say. */
function flankProps(state: ChainState): {
  core: { cls: string; delta?: string };
  knots: { cls: string; delta?: string };
} {
  const coreH = state.core?.blocks ?? 0;
  const knotsH = state.knots?.blocks ?? 0;
  if (state.split) {
    // Lane colours only — the "+N / +N" score is the hero's line, and repeating it here (and on
    // the rail) made the same number appear three times.
    return {
      core: { cls: 'text-cyan-300' },
      knots: { cls: 'text-slate-300' },
    };
  }
  if (state.rejected) {
    return { core: { cls: 'text-zinc-100' }, knots: { cls: 'text-amber-300', delta: '✕' } };
  }
  if (state.syncing) {
    const d = `−${formatInt(Math.abs(coreH - knotsH))}`;
    return knotsH < coreH
      ? { core: { cls: 'text-zinc-100' }, knots: { cls: 'text-sky-300', delta: d } }
      : { core: { cls: 'text-sky-300', delta: d }, knots: { cls: 'text-zinc-100' } };
  }
  // In agreement the matching heights ARE the message; no colour needed to assert it.
  return { core: { cls: 'text-zinc-100' }, knots: { cls: 'text-zinc-100' } };
}

/** One node, flanking the clock. Stance over height over client string; the delta rides the height
 *  as a superscript on the clock-facing side. No liveness dot — a dead node says OFFLINE instead. */
function NodeFlank({
  node,
  side,
  cls,
  delta,
}: {
  node: NodeInfo;
  side: Side;
  cls: string;
  delta?: string;
}) {
  const stance = side === 'knots' ? 'SIGNALING' : 'NON-SIGNALING';
  return (
    <div
      data-side={side}
      className={clsx(
        'flex w-44 shrink-0 flex-col leading-tight',
        side === 'core' ? 'items-end text-right' : 'items-start text-left',
      )}
      title={node.version}
    >
      <div
        className={clsx(
          'text-[10px] font-bold uppercase tracking-wider',
          !node.online ? 'text-red-400' : side === 'knots' ? 'text-emerald-300' : 'text-zinc-400',
        )}
      >
        {node.online ? stance : 'OFFLINE'}
      </div>
      <div className={clsx('font-mono text-2xl font-extrabold tabular-nums', cls)}>
        {side === 'knots' && delta && (
          <span className="mr-1 align-super text-xs font-extrabold">{delta}</span>
        )}
        {fmtHeight(node.blocks)}
        {side === 'core' && delta && (
          <span className="ml-1 align-super text-xs font-extrabold">{delta}</span>
        )}
      </div>
      <div className="text-[9px] text-zinc-600">{node.version}</div>
    </div>
  );
}

/** A plain status headline — used for every state that is not the countdown. */
interface StatusHero {
  kind: 'status';
  tone: Tone;
  value: string;
  eyebrow: string;
  caption: string;
  /** Re-mount key: changing it replays the hero's entry animation, so a new block reads as a beat. */
  pulse?: string;
  /** Set on a split: the per-branch blocks-since-fork, rendered as segment counters. */
  split?: { core: number; knots: number };
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
}

type Hero = StatusHero | CountdownHero;

function useHero(state: ChainState | null): Hero | null {
  const recentBlocks = useStore((s) => s.recentBlocks);
  const recentLoaded = useStore((s) => s.recentLoaded);
  const rate = useMemo(() => estimateRate(recentBlocks), [recentBlocks]);

  // Countdown inputs, hoisted above the branches below because the held ETA is a hook and so cannot
  // sit inside the `sf && !sf.reached` arm where it is actually used.
  const sf = state?.scheduled_fork ?? null;
  const blocksUntil = sf && !sf.reached ? sf.blocks_until : null;
  // Only the countdown reads the clock. With no target to count down to, a 1 Hz tick would still
  // re-render the header, both node flanks and the race rail's whole SVG every second to draw
  // exactly what was already on screen — so the ticker is switched off instead.
  const now = useNow(blocksUntil != null ? 1000 : 0);
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
      eyebrow: `Chain split at #${fmtHeight(at)}`,
      // No caption: the flanking heights and the forked rail below already say all of this.
      caption: '',
      pulse: `${coreAhead}:${knotsAhead}`,
      split: { core: coreAhead, knots: knotsAhead },
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
      // No caption: the flanks carry the heights and the rail's ✕ marker carries the rest.
      caption: '',
    };
  }

  if (state.syncing) {
    return {
      kind: 'status',
      tone: 'sky',
      value: 'SYNCING',
      eyebrow: 'Nodes catching up',
      caption: `non-signaling #${fmtHeight(state.core?.blocks)} · signaling #${fmtHeight(state.knots?.blocks)} — one node behind, not a split`,
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
      eyebrow: etaDate ?? `${label} · #${fmtHeight(sf.height)}`,
      // Just the distance to the target. The band, the rate and the retarget split were all true and
      // all noise: they moved on their own, none of them changed what a viewer would do, and they
      // buried the one number that does. Under the block face even this is redundant with the digits
      // above it, so it goes.
      caption:
        face === 'clock' ? `${formatInt(n)} block${n === 1 ? '' : 's'} to go` : '',
      blocks: n,
      seconds,
      face,
    };
  }

  // Target passed, or none configured (the countdown simply is not applicable).
  return {
    kind: 'status',
    tone: 'emerald',
    value: 'IN AGREEMENT',
    eyebrow: sf ? `Past #${fmtHeight(sf.height)}` : 'Single chain',
    caption: `both nodes on the same tip · #${fmtHeight(state.tip_height)}`,
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
      ) : hero.split ? (
        // The split scoreboard: each branch's blocks-since-fork as a segment counter in its lane
        // colour, separated by a single red bar — the tear itself, in the clock's own language.
        <div
          key={hero.pulse}
          className="fw-hero-in mt-2 flex items-start justify-center gap-7 sm:gap-9"
        >
          <SegmentNumber value={hero.split.core} label="non-signaling" plus className="text-cyan-300" />
          <SegmentBar className="text-red-400" />
          <SegmentNumber value={hero.split.knots} label="signaling" plus className="text-slate-300" />
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
        <div className="pointer-events-none absolute inset-y-0 left-5 flex items-center">
          <Brand />
        </div>
        <div className="absolute inset-y-0 right-5 flex items-center">
          <GithubLink />
        </div>
        <div className="mx-auto flex max-w-6xl items-center justify-center">
          <span className="text-sm text-zinc-500">
            {error ? `Connection error: ${error}` : 'Connecting to nodes…'}
          </span>
        </div>
      </header>
    );
  }

  const fp = flankProps(state);

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/70 backdrop-blur">
      <div className="pointer-events-none absolute inset-y-0 left-5 z-10 flex items-center">
        <Brand />
      </div>
      <div className="absolute inset-y-0 right-5 z-10 flex items-center">
        <GithubLink />
      </div>
      <div className="mx-auto max-w-6xl px-5 py-2.5">
        {/* The instrument row: the two nodes flank the clock they are racing under. */}
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
          <NodeFlank node={state.core} side="core" cls={fp.core.cls} delta={fp.core.delta} />
          <HeroBlock hero={hero} />
          <NodeFlank node={state.knots} side="knots" cls={fp.knots.cls} delta={fp.knots.delta} />
        </div>

        <RaceRail state={state} />

        {error && (
          <div className="mt-1.5 text-center text-[10px] text-amber-400/80">
            Live update issue: {error} — retrying…
          </div>
        )}
      </div>
    </header>
  );
}
