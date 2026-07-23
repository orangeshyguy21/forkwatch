import { create } from 'zustand';
import { fetchBlocks, fetchBlocksRange, fetchState } from './api';
import type { Block, ChainState, PushFrame } from './types';

const PAGE_SIZE = 30;

// Window of recent blocks kept fresh purely to feed the header's block-rate estimator (see eta.ts).
// 144 = one mainnet day; on regtest it is simply "plenty". Held separately from `blocks` because
// that list grows downwards with pagination and only its top page is refreshed.
const RECENT_WINDOW = 144;

// Aligned chunk size for range fetches. Windows shift by ~1 height per frame while
// scrolling, so we fetch in fixed aligned chunks and dedupe in-flight chunks to
// avoid request storms. Kept well under the backend's ~600 window cap.
const CHUNK = 64;

function chunkStart(h: number): number {
  return Math.floor(h / CHUNK) * CHUNK;
}

function mergeBlocks(existing: Block[], incoming: Block[]): Block[] {
  const byHash = new Map<string, Block>();
  for (const b of existing) byHash.set(b.hash, b);
  for (const b of incoming) byHash.set(b.hash, b);
  // Descending by height; stable tiebreak by hash so multi-height forks are deterministic.
  return Array.from(byHash.values()).sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
}

interface StoreState {
  state: ChainState | null;
  stateError: string | null;
  stateLoading: boolean;

  blocks: Block[];
  hasMore: boolean;
  loadingMore: boolean;
  blocksError: string | null;
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

  refreshState: () => Promise<void>;
  refreshTop: () => Promise<void>;
  refreshRecent: () => Promise<void>;
  /** Apply a WebSocket push frame. Returns true when the frame could NOT be applied completely and
   *  the caller should fall back to HTTP — either it carried no payload, or the pushed blocks do not
   *  abut the recent window (the client missed more blocks than a frame carries), which would leave
   *  the block-rate estimator measuring across a hole. */
  applyPush: (frame: PushFrame) => boolean;
  loadMore: () => Promise<void>;
  bootstrap: () => Promise<void>;
  // Fill blocksByHeight for the inclusive window [from, to]. Fetches only the
  // aligned chunks that contain missing heights and dedupes in-flight chunks.
  fetchRange: (from: number, to: number) => Promise<void>;
  // Same, but for the Knots chain (chain=knots) into knotsBlocksByHeight.
  fetchKnotsRange: (from: number, to: number) => Promise<void>;
}

// In-flight chunk starts, shared across calls (not part of reactive state).
const inflightChunks = new Set<number>();
const inflightKnotsChunks = new Set<number>();

export const useStore = create<StoreState>((set, get) => ({
  state: null,
  stateError: null,
  stateLoading: false,

  blocks: [],
  hasMore: true,
  loadingMore: false,
  blocksError: null,
  initialized: false,

  recentBlocks: [],
  recentLoaded: false,

  tipHeight: null,
  pruneFloor: null,
  blocksByHeight: new Map<number, Block>(),
  knotsBlocksByHeight: new Map<number, Block>(),

  refreshState: async () => {
    set({ stateLoading: true });
    try {
      const state = await fetchState();
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

  refreshTop: async () => {
    try {
      const page = await fetchBlocks({ limit: PAGE_SIZE });
      set((s) => ({
        blocks: mergeBlocks(s.blocks, page.blocks),
        // Only tighten hasMore if we had nothing before (avoid clobbering deep-scroll state).
        hasMore: s.blocks.length === 0 ? page.has_more : s.hasMore,
        blocksError: null,
      }));
    } catch (err) {
      set({ blocksError: (err as Error).message });
    }
  },

  refreshRecent: async () => {
    try {
      const page = await fetchBlocks({ limit: RECENT_WINDOW });
      // Replaced wholesale rather than merged: on a reorg the estimator must not keep timestamps
      // from blocks that are no longer on the chain it is measuring.
      set({ recentBlocks: page.blocks, recentLoaded: true });
    } catch {
      // Non-fatal: the clock simply keeps its last estimate. Surfacing this would duplicate the
      // errors already reported by refreshState/refreshTop. Still mark it settled, or a permanently
      // failing fetch would leave the header stuck showing nothing.
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

        next.blocks = mergeBlocks(s.blocks, pushed);

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
        next.blocksError = null;
      }

      return next;
    });
    return gap;
  },

  loadMore: async () => {
    const { loadingMore, hasMore, blocks } = get();
    if (loadingMore || !hasMore) return;
    set({ loadingMore: true });
    try {
      const lowest = blocks.length ? blocks[blocks.length - 1].height : undefined;
      const page = await fetchBlocks({ before: lowest, limit: PAGE_SIZE });
      set((s) => ({
        blocks: mergeBlocks(s.blocks, page.blocks),
        hasMore: page.has_more,
        loadingMore: false,
        blocksError: null,
      }));
    } catch (err) {
      set({ loadingMore: false, blocksError: (err as Error).message });
    }
  },

  bootstrap: async () => {
    await get().refreshState();
    // Kicked off before the range fetch is awaited: the header shows neither countdown face until
    // this settles, so any delay here is dead space at the top of the page.
    void get().refreshRecent();
    // Seed the isometric window near the tip; this also gives us prune_floor.
    const tip = get().tipHeight;
    if (typeof tip === 'number') {
      await get().fetchRange(tip - 120, tip);
    }
    set({ initialized: true });
    // Legacy list view still populates in the background; harmless if unused.
    void get().refreshTop();
  },

  fetchRange: async (from, to) => {
    const s = get();
    const tip = s.tipHeight;
    const floor = s.pruneFloor;
    const lo = Math.max(0, Math.floor(from), floor ?? 0);
    const hi = Math.floor(Math.min(to, tip ?? to));
    if (hi < lo) return;

    // Which aligned chunks touch [lo, hi] and still have missing heights?
    const map = s.blocksByHeight;
    const starts: number[] = [];
    for (let c = chunkStart(lo); c <= chunkStart(hi); c += CHUNK) {
      if (inflightChunks.has(c)) continue;
      let missing = false;
      const cEnd = c + CHUNK - 1;
      const scanLo = Math.max(c, lo, floor ?? c);
      const scanHi = Math.min(cEnd, tip ?? cEnd);
      for (let h = scanLo; h <= scanHi; h++) {
        if (!map.has(h)) {
          missing = true;
          break;
        }
      }
      if (missing) starts.push(c);
    }
    if (starts.length === 0) return;

    starts.forEach((c) => inflightChunks.add(c));
    await Promise.all(
      starts.map(async (c) => {
        try {
          const page = await fetchBlocksRange(c, c + CHUNK - 1);
          set((cur) => {
            const next = new Map(cur.blocksByHeight);
            for (const b of page.blocks) next.set(b.height, b);
            return {
              blocksByHeight: next,
              tipHeight:
                typeof page.tip_height === 'number' ? page.tip_height : cur.tipHeight,
              pruneFloor:
                typeof page.prune_floor === 'number' ? page.prune_floor : cur.pruneFloor,
              blocksError: null,
            };
          });
        } catch (err) {
          set({ blocksError: (err as Error).message });
        } finally {
          inflightChunks.delete(c);
        }
      }),
    );
  },

  fetchKnotsRange: async (from, to) => {
    const s = get();
    const floor = s.pruneFloor ?? 0;
    const knotsTip = s.state?.knots?.blocks ?? to; // Knots chain height caps how far up it exists
    const lo = Math.max(0, Math.floor(from), floor);
    const hi = Math.floor(Math.min(to, knotsTip));
    if (hi < lo) return;
    const map = s.knotsBlocksByHeight;
    const starts: number[] = [];
    for (let c = chunkStart(lo); c <= chunkStart(hi); c += CHUNK) {
      if (inflightKnotsChunks.has(c)) continue;
      let missing = false;
      const scanHi = Math.min(c + CHUNK - 1, hi);
      for (let h = Math.max(c, lo); h <= scanHi; h++) {
        if (!map.has(h)) {
          missing = true;
          break;
        }
      }
      if (missing) starts.push(c);
    }
    if (starts.length === 0) return;
    starts.forEach((c) => inflightKnotsChunks.add(c));
    await Promise.all(
      starts.map(async (c) => {
        try {
          const page = await fetchBlocksRange(c, c + CHUNK - 1, 'knots');
          set((cur) => {
            const next = new Map(cur.knotsBlocksByHeight);
            for (const b of page.blocks) next.set(b.height, b);
            return { knotsBlocksByHeight: next };
          });
        } catch (err) {
          set({ blocksError: (err as Error).message });
        } finally {
          inflightKnotsChunks.delete(c);
        }
      }),
    );
  },
}));
