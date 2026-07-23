import { create } from 'zustand';
import { fetchBlocks, fetchBlocksRange, fetchState } from './api';
import type { Block, ChainState, PushFrame, Side } from './types';

// Window of recent blocks kept fresh purely to feed the header's block-rate estimator (see eta.ts).
// 144 = one mainnet day; on regtest it is simply "plenty".
const RECENT_WINDOW = 144;

// Aligned chunk size for range fetches. Windows shift by ~1 height per frame while
// scrolling, so we fetch in fixed aligned chunks and dedupe in-flight chunks to
// avoid request storms. Kept well under the backend's ~600 window cap.
const CHUNK = 64;

function chunkStart(h: number): number {
  return Math.floor(h / CHUNK) * CHUNK;
}

interface StoreState {
  state: ChainState | null;
  stateError: string | null;
  stateLoading: boolean;
  initialized: boolean;

  /** Most recent blocks, tip-first — the sample the header clock estimates block rate from. */
  recentBlocks: Block[];
  /** True once the first recent-window fetch has settled, successfully or not. Until then the
   *  header cannot know which countdown face to show, and must show neither rather than flashing
   *  the wrong one. */
  recentLoaded: boolean;

  // Isometric-chain data: contiguous height space keyed by height.
  tipHeight: number | null;
  pruneFloor: number | null;
  blocksByHeight: Map<number, Block>; // Core node's chain
  knotsBlocksByHeight: Map<number, Block>; // Knots node's chain (its minority branch during a fork)

  /** `fresh` bypasses the browser HTTP cache — used by bootstrap so a reload cannot start the view
   *  from a stale cached tip (see fetchState). The fallback poll leaves it off. */
  refreshState: (fresh?: boolean) => Promise<void>;
  refreshRecent: () => Promise<void>;
  /** Apply a WebSocket push frame. Returns true when the frame could NOT be applied completely and
   *  the caller should fall back to HTTP — either it carried no payload, or the pushed blocks do not
   *  abut the recent window (the client missed more blocks than a frame carries), which would leave
   *  the block-rate estimator measuring across a hole. */
  applyPush: (frame: PushFrame) => boolean;
  bootstrap: () => Promise<void>;
  // Fill blocksByHeight for the inclusive window [from, to]. Fetches only the
  // aligned chunks that contain missing heights and dedupes in-flight chunks.
  fetchRange: (from: number, to: number, fresh?: boolean) => Promise<void>;
  // Same, but for the Knots chain (chain=knots) into knotsBlocksByHeight.
  fetchKnotsRange: (from: number, to: number) => Promise<void>;
}

// In-flight chunk starts per side, shared across calls (not part of reactive state).
const inflight: Record<Side, Set<number>> = { core: new Set(), knots: new Set() };

// The two chains' range fetches differ only in these three things: which map they fill, and what
// caps the top of their height space. Core is capped by the shared tip; Knots by its own chain
// height, which during a fork is the shorter of the two.
const SIDES: Record<Side, { map: 'blocksByHeight' | 'knotsBlocksByHeight'; tipOf: (s: StoreState) => number | null }> = {
  core: { map: 'blocksByHeight', tipOf: (s) => s.tipHeight },
  knots: { map: 'knotsBlocksByHeight', tipOf: (s) => s.state?.knots?.blocks ?? null },
};

export const useStore = create<StoreState>((set, get) => {
  // One chunked fetcher for both chains. Previously this existed twice, and the copies had already
  // drifted apart in their clamping and their write-back behaviour.
  const fetchSide = async (side: Side, from: number, to: number, fresh = false) => {
    const { map: mapKey, tipOf } = SIDES[side];
    const s = get();
    const tip = tipOf(s);
    const lo = Math.max(0, Math.floor(from), s.pruneFloor ?? 0);
    const hi = Math.floor(Math.min(to, tip ?? to));
    if (hi < lo) return;

    // Which aligned chunks touch [lo, hi] and still have missing heights?
    const map = s[mapKey];
    const starts: number[] = [];
    for (let c = chunkStart(lo); c <= chunkStart(hi); c += CHUNK) {
      if (inflight[side].has(c)) continue;
      // Scan only the requested window, not the whole chunk: heights outside [lo, hi] are not
      // this call's business, and counting them as "missing" would fetch chunks nobody asked for.
      const scanHi = Math.min(c + CHUNK - 1, hi);
      for (let h = Math.max(c, lo); h <= scanHi; h++) {
        if (!map.has(h)) {
          starts.push(c);
          break;
        }
      }
    }
    if (starts.length === 0) return;

    starts.forEach((c) => inflight[side].add(c));
    await Promise.all(
      starts.map(async (c) => {
        try {
          const page = await fetchBlocksRange(c, c + CHUNK - 1, side, undefined, fresh);
          set((cur) => {
            const next = new Map(cur[mapKey]);
            for (const b of page.blocks) next.set(b.height, b);
            // Only Core's response defines the shared height space. A Knots range reports the Knots
            // chain's own tip, which during a fork is behind Core's — writing it back would drag
            // the scroller's ceiling down onto the minority branch.
            if (side === 'knots') return { [mapKey]: next } as Partial<StoreState>;
            // A range response may only RAISE the known tip, never lower it. These responses are
            // cacheable (`max-age=5`), so a scroll-driven range fetch can be served an older tip
            // than the one already in hand and would otherwise drag the whole view backward — the
            // chain's top block would unmount and remount, restarting its animation. A genuine
            // reorg still lowers the tip: /api/state and the WebSocket push assign it directly.
            const pagedTip = typeof page.tip_height === 'number' ? page.tip_height : null;
            return {
              blocksByHeight: next,
              tipHeight:
                pagedTip == null
                  ? cur.tipHeight
                  : cur.tipHeight == null
                    ? pagedTip
                    : Math.max(cur.tipHeight, pagedTip),
              pruneFloor: typeof page.prune_floor === 'number' ? page.prune_floor : cur.pruneFloor,
            };
          });
        } catch {
          // Left silent on purpose: the heights stay missing from the map, so the next scroll-driven
          // call for this window retries them. Surfacing it would need an error channel that no view
          // renders.
        } finally {
          inflight[side].delete(c);
        }
      }),
    );
  };

  return {
    state: null,
    stateError: null,
    stateLoading: false,
    initialized: false,

    recentBlocks: [],
    recentLoaded: false,

    tipHeight: null,
    pruneFloor: null,
    blocksByHeight: new Map<number, Block>(),
    knotsBlocksByHeight: new Map<number, Block>(),

    refreshState: async (fresh = false) => {
      set({ stateLoading: true });
      try {
        const state = await fetchState(undefined, fresh);
        set((s) => ({
          state,
          stateError: null,
          stateLoading: false,
          // Keep tip/floor fresh from state so the scroller has both bounds without waiting on a
          // range fetch (fixes the focus-init race).
          tipHeight: typeof state.tip_height === 'number' ? state.tip_height : s.tipHeight,
          pruneFloor: typeof state.prune_floor === 'number' ? state.prune_floor : s.pruneFloor,
        }));
      } catch (err) {
        set({ stateError: (err as Error).message, stateLoading: false });
      }
    },

    refreshRecent: async () => {
      try {
        const page = await fetchBlocks(RECENT_WINDOW);
        // Replaced wholesale rather than merged: on a reorg the estimator must not keep timestamps
        // from blocks that are no longer on the chain it is measuring.
        set({ recentBlocks: page.blocks, recentLoaded: true });
      } catch {
        // Non-fatal: the clock simply keeps its last estimate. Surfacing this would duplicate the
        // error already reported by refreshState. Still mark it settled, or a permanently failing
        // fetch would leave the header stuck showing nothing.
        set({ recentLoaded: true });
      }
    },

    applyPush: (frame) => {
      const pushed = frame.blocks ?? [];
      if (!frame.state && pushed.length === 0) return true; // payload-less frame: caller refetches

      let gap = false;
      set((s) => {
        const next: Partial<StoreState> = {};

        if (frame.state) {
          next.state = frame.state;
          next.stateError = null;
          next.stateLoading = false;
          if (typeof frame.state.tip_height === 'number') next.tipHeight = frame.state.tip_height;
          if (typeof frame.state.prune_floor === 'number') next.pruneFloor = frame.state.prune_floor;
        }

        if (pushed.length) {
          const minH = Math.min(...pushed.map((b) => b.height));

          const byHeight = new Map(s.blocksByHeight);
          for (const b of pushed) byHeight.set(b.height, b);
          next.blocksByHeight = byHeight;

          // Everything at or above the pushed window is replaced wholesale rather than merged: on a
          // reorg the estimator must not keep timestamps from blocks that left the chain.
          const kept = s.recentBlocks.filter((b) => b.height < minH);
          // If what we keep does not sit directly below the pushed window, the client missed more
          // blocks than a frame carries and the window is discontinuous — signal a refetch.
          if (kept.length > 0 && kept[0].height !== minH - 1) gap = true;
          next.recentBlocks = [...pushed, ...kept]
            .sort((a, b) => b.height - a.height)
            .slice(0, RECENT_WINDOW);
          next.recentLoaded = true;
        }

        return next;
      });
      return gap;
    },

    bootstrap: async () => {
      // Both bootstrap reads bypass the browser cache: they decide which height the whole view
      // anchors on, and a cached response makes a reload start one block behind the real tip.
      await get().refreshState(true);
      // Kicked off before the range fetch is awaited: the header shows neither countdown face until
      // this settles, so any delay here is dead space at the top of the page.
      void get().refreshRecent();
      // Seed the isometric window near the tip; this also gives us prune_floor.
      const tip = get().tipHeight;
      if (typeof tip === 'number') {
        await get().fetchRange(tip - 120, tip, true);
      }
      set({ initialized: true });
    },

    fetchRange: (from, to, fresh) => fetchSide('core', from, to, fresh),
    fetchKnotsRange: (from, to) => fetchSide('knots', from, to),
  };
});
