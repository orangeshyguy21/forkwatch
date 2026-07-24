import { useEffect, useState } from 'react';

/**
 * Coarse layout tier for the whole app. The isometric chain is a three-column desktop instrument;
 * below these widths the rails reflow (tablet drops the epoch rail to an overlay; phone also swaps
 * the timeline rail for a bottom scrubber and the drawer for a bottom sheet). Breakpoints match
 * Tailwind's `sm` (640) and `lg` (1024) so class-based and JS-based switches agree.
 *
 *  phone   : < 640   — full-bleed chain, all navigation collapsed
 *  tablet  : 640–1023 — chain + right timeline rail, epoch rail on demand
 *  desktop : ≥ 1024  — the untouched three-column layout
 */
export type Breakpoint = 'phone' | 'tablet' | 'desktop';

function current(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  return w < 640 ? 'phone' : w < 1024 ? 'tablet' : 'desktop';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(current);
  useEffect(() => {
    const on = () => setBp(current());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return bp;
}
