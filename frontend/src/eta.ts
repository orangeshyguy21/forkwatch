// Block-arrival ETA estimation — the maths behind the header clock.
//
// Block production is a Poisson process: interarrival times are iid and, on a real chain,
// exponentially distributed. Two quantities drive the countdown:
//
//   m — the mean seconds per block *right now* (tracks hashrate, so it must be recency-weighted)
//   σ — the spread of a single interval (drives the confidence band)
//
// Both come from recent block header timestamps. They are then combined into a moment-matched
// Gamma estimate of the time for the next n blocks: mean n·m, sd √n·σ.
//
// We deliberately do NOT hardcode the exponential's identity σ = m. The regtest miner emits blocks
// on a fixed cadence (σ ≈ 0) while mainnet is genuinely exponential (σ ≈ m); matching the *empirical*
// spread makes the band honest in both regimes and collapses it to a point for a metronome miner.
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
/** z for the 10th/90th percentile — the band we display. */
const Z_80 = 1.2815515655446004;

/**
 * Residual uncertainty in the post-retarget segment. Difficulty pulls the interval back to target,
 * but not perfectly: it corrects with one epoch's lag, so a hashrate trend leaves a few percent on
 * the table. Small, but it is the only uncertainty that segment has.
 */
const POST_RETARGET_DRIFT = 0.05;

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
  /** Weighted sd of a *single* interval, seconds. Near 0 for a fixed-cadence miner. */
  sdInterval: number;
  /** How many interval samples backed the estimate. */
  samples: number;
  /**
   * Effective sample size of the weighted mean, (Σw)²/Σw². The exponential decay means this is far
   * below `samples`, and it sets how precisely we know the rate at all — the dominant uncertainty
   * on any long countdown, since it scales with the estimate instead of shrinking like √n.
   */
  nEff: number;
  /** Height/time of the most recent block the estimate saw. */
  lastHeight: number;
  lastTime: number;
}

export interface EtaEstimate extends RateEstimate {
  /** Blocks remaining to the target. */
  blocks: number;
  /** Expected seconds from `lastTime` to the target height. */
  seconds: number;
  /** 10th and 90th percentile of that duration, seconds. */
  lo: number;
  hi: number;
  /** Of `blocks`, how many are priced at the measured rate vs at the protocol target. */
  blocksMeasured: number;
  blocksAtTarget: number;
  /** Blended seconds per block actually used — what the countdown implies end to end. */
  effectiveInterval: number;
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

/** Recency-weighted mean/sd of the recent interval samples. Null if there isn't enough signal. */
export function estimateRate(blocks: Block[]): RateEstimate | null {
  const series = cleanSeries(blocks);
  if (series.length < MIN_SAMPLES + 1) return null;
  const samples = intervalSamples(series);
  if (samples.length < MIN_SAMPLES) return null;

  // Exponential decay by age *in blocks*, so the estimate tracks hashrate rather than wall time.
  let v1 = 0; // Σw
  let v2 = 0; // Σw²
  let sum = 0; // Σw·x
  for (let j = 0; j < samples.length; j++) {
    const w = Math.pow(0.5, j / HALF_LIFE_BLOCKS);
    v1 += w;
    v2 += w * w;
    sum += w * samples[j];
  }
  const mean = sum / v1;

  // Weighted unbiased variance (reliability-weight form): Σw(x−μ)² / (V1 − V2/V1).
  let ss = 0;
  for (let j = 0; j < samples.length; j++) {
    const w = Math.pow(0.5, j / HALF_LIFE_BLOCKS);
    const d = samples[j] - mean;
    ss += w * d * d;
  }
  const denom = v1 - v2 / v1;
  const variance = denom > 0 ? Math.max(0, ss / denom) : 0;

  if (!(mean > 0) || !Number.isFinite(mean)) return null;

  // The countdown anchors on the tip's *raw* timestamp, not the smoothed series: the median filter
  // is centred, so at the edge it reports a value up to two blocks stale — fine for measuring a
  // rate, wrong for "when did the last block land".
  let last = blocks[0];
  for (const b of blocks) if (b && b.height > (last?.height ?? -1)) last = b;

  return {
    meanInterval: mean,
    sdInterval: Math.sqrt(variance),
    samples: samples.length,
    nEff: v2 > 0 ? (v1 * v1) / v2 : 0,
    lastHeight: last.height,
    lastTime: last.time,
  };
}

/**
 * Wilson–Hilferty quantile of Gamma(shape k, scale θ) — a cube-root normal transform that is
 * accurate to well under a display second for k ≳ 1 and needs no special functions.
 */
function gammaQuantile(k: number, theta: number, z: number): number {
  if (!(k > 0) || !(theta > 0)) return 0;
  const t = 1 - 1 / (9 * k) + z / (3 * Math.sqrt(k));
  return Math.max(0, k * theta * t * t * t);
}

/**
 * Time for the next `blocks` blocks, as a distribution.
 *
 * The horizon is split at the next difficulty retarget, because the measured rate only predicts the
 * blocks still mined under today's difficulty. Past that boundary the protocol drags the interval
 * back to `targetSpacing`, and extrapolating a measured rate through it is simply wrong — a 12%
 * hashrate blip carried across 2,000 blocks moves a three-week countdown by two days, and the
 * retarget would have erased it. With no pacing model supplied the whole horizon uses the measured
 * rate, which is right where difficulty never binds (regtest).
 *
 * Three independent sources of error, added in quadrature:
 *
 *   Poisson    √n·σ            — the blocks' own randomness. Shrinks like √n *relative* to the mean.
 *   rate       n·m/√nEff       — how badly we know m. Scales WITH the mean, so it dominates any long
 *                                countdown. Omitting it made the old band ~7x too narrow.
 *   drift      n·target·5%     — hashrate wander that difficulty has not corrected yet.
 *
 * A Gamma is then fitted to that mean and sd. For n = 1 on exponential data it reproduces the
 * exponential (k ≈ 1); for a fixed-cadence miner σ → 0, k → ∞ and the band collapses onto the mean.
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

  const mean = measured * measuredInterval + atTarget * target;
  if (!(mean > 0)) return null;

  const poissonVar = blocks * rate.sdInterval * rate.sdInterval;
  const rateSe = rate.nEff > 0 ? 1 / Math.sqrt(rate.nEff) : 0;
  const rateVar = Math.pow(measured * measuredInterval * rateSe, 2);
  const driftVar = Math.pow(atTarget * target * POST_RETARGET_DRIFT, 2);
  const sd = Math.sqrt(poissonVar + rateVar + driftVar);

  let lo = mean;
  let hi = mean;
  if (sd > 0) {
    const k = (mean * mean) / (sd * sd);
    const theta = (sd * sd) / mean;
    lo = gammaQuantile(k, theta, -Z_80);
    hi = gammaQuantile(k, theta, Z_80);
  }
  return {
    ...rate,
    blocks,
    seconds: mean,
    lo,
    hi,
    blocksMeasured: measured,
    blocksAtTarget: atTarget,
    effectiveInterval: mean / blocks,
  };
}

/** HH:MM:SS, widening to `Nd HH:MM` past a day and narrowing to MM:SS under an hour. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${p(hh)}:${p(mm)}`;
  if (hh > 0) return `${p(hh)}:${p(mm)}:${p(ss)}`;
  return `${p(mm)}:${p(ss)}`;
}

/**
 * Compact duration for the confidence band: `3h 40m`, `10m 47s`, `45s`.
 *
 * Keeps seconds below the ten-minute mark. A tight band (a fixed-cadence miner produces them) would
 * otherwise round to an identical `11m–11m` at both ends and read as a bug.
 */
export function formatDurationShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** `~9.7s/block`, `~10m 4s/block` — the rate, stated the way a human reads it. */
export function formatRate(secondsPerBlock: number): string {
  if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) return '—';
  if (secondsPerBlock < 60) return `${secondsPerBlock.toFixed(1)}s/block`;
  const m = Math.floor(secondsPerBlock / 60);
  const s = Math.round(secondsPerBlock % 60);
  return s ? `${m}m ${s}s/block` : `${m}m/block`;
}
