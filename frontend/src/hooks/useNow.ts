import { useEffect, useState } from 'react';

/**
 * Wall-clock milliseconds, re-rendered on a fixed cadence. This is what makes the header clock
 * tick between block arrivals — the ETA itself is a fixed instant, refreshed only every 72 blocks.
 *
 * The interval is re-aligned after every tick rather than free-running, so a tab that gets throttled
 * in the background resumes on time instead of drifting.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = intervalMs - (Date.now() % intervalMs);
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [intervalMs]);

  return now;
}
