import { useEffect, useState } from 'react';

/**
 * How far past the phase each tick is deliberately scheduled. A countdown reads a step function —
 * `floor((target - now) / 1000)` — and sampling it at the instant it steps is a coin flip decided by
 * timer jitter, which is what made the clock skip. Landing a hair AFTER the step makes every sample
 * unambiguous. Big enough to absorb ordinary setTimeout lateness (measured at 9–19ms), small enough
 * to be invisible.
 */
const PHASE_EPSILON_MS = 40;

/**
 * Wall-clock milliseconds, re-rendered on a fixed cadence. This is what makes the header clock
 * tick between block arrivals — the ETA itself is a fixed instant, refreshed only every 72 blocks.
 *
 * `phaseMs` is the instant the caller's display actually changes on (for a countdown: the target
 * instant). Ticks are locked to that phase, plus PHASE_EPSILON_MS, rather than to the top of the
 * wall-clock second. This matters more than it sounds: a countdown target lands on a whole second
 * whenever the ETA is a whole number of seconds off a block header timestamp — which is the *normal*
 * case on mainnet, since header times are integer seconds and eta.ts clamps the per-block interval to
 * a whole-second band edge. A ticker aligned to the wall second then samples the countdown exactly as
 * it steps, and a few ms of jitter decides whether it reads n or n-1: the display oscillated by one,
 * skipping a number and then holding the next for two seconds. Phase-locking removes the race
 * entirely instead of hoping the two phases stay apart.
 *
 * The interval is re-aligned after every tick rather than free-running, so a tab that gets throttled
 * in the background resumes on time instead of drifting.
 *
 * A non-positive interval disables the ticker entirely. Callers pass 0 when nothing on screen is
 * counting down, so a subtree that would re-render once a second to produce identical output simply
 * stops.
 */
export function useNow(intervalMs = 1000, phaseMs = 0): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (intervalMs <= 0) return;
    // Where in the cycle the caller's display steps. Modulo is written to stay non-negative for a
    // phase in the past (a countdown target always is, once it passes).
    const phase = (((phaseMs + PHASE_EPSILON_MS) % intervalMs) + intervalMs) % intervalMs;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const since = (((Date.now() - phase) % intervalMs) + intervalMs) % intervalMs;
      // A full interval when we are already exactly on phase — never a zero-delay tick.
      const delay = intervalMs - since;
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [intervalMs, phaseMs]);

  return now;
}
