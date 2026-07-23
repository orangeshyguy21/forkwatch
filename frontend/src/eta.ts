// Block-arrival ETA estimation — the maths behind the header clock.
//
// Block production is a Poisson process: interarrival times are iid and, on a real chain,
// exponentially distributed. One quantity drives the countdown:
//
//   m — the mean seconds per block *right now* (tracks hashrate, so it must be recency-weighted)
//
// It comes from recent block header timestamps, and is projected across the blocks remaining to the
// target. The horizon is split at the next difficulty retarget, because a measured rate only
// predicts the blocks still mined under today's difficulty.
//
// This file used to also produce an 80% confidence band (a moment-matched Gamma over the measured
// spread). The header dropped it deliberately — see the note at the countdown hero in Header.tsx:
// the band was true and was noise. The machinery behind it went with it.
//
// Header timestamps are miner-chosen and only loosely ordered (a block's time must merely exceed the
// median of the previous 11), so the raw series can step backwards. Everything below is built to
// survive that — see cleanSeries().

import type { Block } from './types';

/** Blocks of decay for the interval weighting. Roughly ~35 effective samples of memory. */
const HALF_LIFE_BLOCKS = 24;
/** Max half-width of the median filter used to repair out-of-order header timestamps. */
const MEDIAN_HALF_WIDTH = 3;
/** Minimum interval samples before we're willing to show a clock at all. */
const MIN_SAMPLES = 3;
/** Leverage bound: a single interval may not exceed this multiple of the rough median. */
const OUTLIER_FACTOR = 20;

/**
 * Bounds on the per-block interval used for the blocks still mined under today's difficulty, as a
 * fraction of the protocol target. Difficulty retargeting holds the *long-run* average within a few
 * percent of the target, so a lucky or unlucky streak in the recency-weighted measured rate must not
 * be extrapolated across a whole epoch — carried over ~2,000 blocks a 20% swing moves the countdown
 * by days, which is exactly the twitch this clamp exists to kill. Inside the band the measured rate
 * still steers the estimate; outside it we trust the protocol over a fleeting streak. Only applied
 * when a pacing model supplies a real target (mainnet); regtest's metronome sits inside the band and
 * is untouched. The floor sits just below target because hashrate growth makes real epochs run a
 * touch fast.
 */
const MEASURED_INTERVAL_MIN_FRAC = 0.98;
const MEASURED_INTERVAL_MAX_FRAC = 1.05;

export interface RateEstimate {
  /** Recency-weighted mean seconds per block. */
  meanInterval: number;
  /** Height/time of the most recent block the estimate saw. */
  lastHeight: number;
  lastTime: number;
}

export interface EtaEstimate extends RateEstimate {
  /** Blocks remaining to the target. */
  blocks: number;
  /** Expected seconds from `lastTime` to the target height. */
  seconds: number;
}

/** Difficulty geometry for the stretch being estimated. */
export interface PacingModel {
  /** How many of the remaining blocks are mined under the difficulty in force today. */
  blocksAtCurrentDifficulty: number;
  /** Protocol target interval in seconds; blocks past the retarget revert to it. */
  targetSpacing: number;
}

/** Median of a small array. Mutates a copy, so safe on slices. */
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Ascending, height-unique (height, time) series with out-of-order timestamps repaired.
 *
 * A centred median filter is the right tool here: it is the identity on any monotone run (the median
 * of a sorted window *is* its middle element), so a well-behaved chain passes through untouched,
 * while a single block whose miner back- or forward-dated it gets pulled back onto the local trend
 * instead of producing one negative interval and one compensating huge one.
 */
function cleanSeries(blocks: Block[]): Array<{ height: number; time: number }> {
  const byHeight = new Map<number, number>();
  for (const b of blocks) {
    if (!b || !Number.isFinite(b.height) || !Number.isFinite(b.time) || b.time <= 0) continue;
    // On a fork the same height appears twice; keep the earliest, which is the one that
    // actually extended the chain at that point in time.
    const prev = byHeight.get(b.height);
    if (prev == null || b.time < prev) byHeight.set(b.height, b.time);
  }
  const raw = Array.from(byHeight, ([height, time]) => ({ height, time })).sort(
    (a, b) => a.height - b.height,
  );
  return raw.map((pt, i) => {
    // The window must stay *symmetric*, shrinking to nothing at the ends. A truncated window would
    // report the neighbour's timestamp at each end, silently clipping a block or two off the span
    // the rate is measured over — a systematic few-percent underestimate of the interval.
    const half = Math.min(MEDIAN_HALF_WIDTH, i, raw.length - 1 - i);
    if (half === 0) return pt;
    const win = raw.slice(i - half, i + half + 1).map((p) => p.time);
    return { height: pt.height, time: median(win) };
  });
}

/**
 * Per-block interval samples, most-recent-first.
 *
 * Gaps in the series are fine: an interval spanning k heights is divided by k, which is the MLE of
 * the mean interval over that stretch. Samples are clamped rather than dropped so that a genuine
 * hashrate collapse still moves the estimate, but no single sample can dominate it.
 */
function intervalSamples(series: Array<{ height: number; time: number }>): number[] {
  const rough: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const dh = series[i].height - series[i - 1].height;
    const dt = series[i].time - series[i - 1].time;
    if (dh <= 0) continue;
    rough.push(dt / dh);
  }
  if (rough.length === 0) return [];

  // Robust scale for the clamp, from the positive samples only.
  const positive = rough.filter((d) => d > 0);
  const med = positive.length ? median(positive) : 0;
  if (!(med > 0)) return [];
  const min = med / OUTLIER_FACTOR;
  const max = med * OUTLIER_FACTOR;

  return rough.map((d) => Math.min(max, Math.max(min, d))).reverse();
}

/** Recency-weighted mean of the recent interval samples. Null if there isn't enough signal. */
export function estimateRate(blocks: Block[]): RateEstimate | null {
  const series = cleanSeries(blocks);
  if (series.length < MIN_SAMPLES + 1) return null;
  const samples = intervalSamples(series);
  if (samples.length < MIN_SAMPLES) return null;

  // Exponential decay by age *in blocks*, so the estimate tracks hashrate rather than wall time.
  let weight = 0; // Σw
  let sum = 0; // Σw·x
  for (let j = 0; j < samples.length; j++) {
    const w = Math.pow(0.5, j / HALF_LIFE_BLOCKS);
    weight += w;
    sum += w * samples[j];
  }
  const mean = sum / weight;
  if (!(mean > 0) || !Number.isFinite(mean)) return null;

  // The countdown anchors on the tip's *raw* timestamp, not the smoothed series: the median filter
  // is centred, so at the edge it reports a value up to two blocks stale — fine for measuring a
  // rate, wrong for "when did the last block land".
  let last = blocks[0];
  for (const b of blocks) if (b && b.height > (last?.height ?? -1)) last = b;

  return { meanInterval: mean, lastHeight: last.height, lastTime: last.time };
}

/**
 * Expected time for the next `blocks` blocks.
 *
 * The horizon is split at the next difficulty retarget, because the measured rate only predicts the
 * blocks still mined under today's difficulty. Past that boundary the protocol drags the interval
 * back to `targetSpacing`, and extrapolating a measured rate through it is simply wrong — a 12%
 * hashrate blip carried across 2,000 blocks moves a three-week countdown by two days, and the
 * retarget would have erased it. With no pacing model supplied the whole horizon uses the measured
 * rate, which is right where difficulty never binds (regtest).
 */
export function estimateEta(
  rate: RateEstimate | null,
  blocks: number,
  pacing?: PacingModel | null,
): EtaEstimate | null {
  if (!rate || !Number.isFinite(blocks) || blocks <= 0) return null;

  const measured = pacing
    ? Math.max(0, Math.min(blocks, Math.floor(pacing.blocksAtCurrentDifficulty)))
    : blocks;
  const atTarget = blocks - measured;
  const target = pacing && pacing.targetSpacing > 0 ? pacing.targetSpacing : rate.meanInterval;

  // Per-block interval for the measured segment. Where difficulty binds it is clamped to a tight band
  // around the protocol target (see MEASURED_INTERVAL_*_FRAC); with no such target the raw measured
  // rate stands, which is correct on regtest where difficulty never pulls it back.
  const measuredInterval =
    pacing && pacing.targetSpacing > 0
      ? Math.min(
          target * MEASURED_INTERVAL_MAX_FRAC,
          Math.max(target * MEASURED_INTERVAL_MIN_FRAC, rate.meanInterval),
        )
      : rate.meanInterval;

  const seconds = measured * measuredInterval + atTarget * target;
  if (!(seconds > 0)) return null;

  return { ...rate, blocks, seconds };
}
