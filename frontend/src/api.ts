// Same-origin REST client for the Forkwars backend.
import type { BlocksPage, BlocksRange, ChainState, Side, ViolationsResponse } from './types';

const API_BASE = '/api';

// `fresh` bypasses the BROWSER's HTTP cache for this one request. The data endpoints ship
// `max-age` (and `stale-while-revalidate` on /api/state) so that repeated polling is absorbed by
// the cache instead of hitting the origin — which is right for polling, but wrong for the single
// request a page load bootstraps from: a reload inside that window was served the PREVIOUS tip and
// the whole view then anchored one block behind before being corrected. Only the bootstrap opts
// out, so it costs one uncached request per page load and leaves the polling path fully cached.
async function getJson<T>(url: string, signal?: AbortSignal, fresh = false): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' },
    ...(fresh ? { cache: 'no-store' as RequestCache } : null),
  });
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

export function fetchState(signal?: AbortSignal, fresh = false): Promise<ChainState> {
  return getJson<ChainState>(`${API_BASE}/state`, signal, fresh);
}

// Newest `limit` blocks, tip-first. The endpoint also supports a `before` cursor for paging
// downwards; nothing needs it since the isometric scroller reads height ranges instead.
export function fetchBlocks(limit = 30, signal?: AbortSignal): Promise<BlocksPage> {
  return getJson<BlocksPage>(`${API_BASE}/blocks?limit=${limit}`, signal);
}

// Blocks present in the inclusive height range [from, to], ascending. Gaps are
// allowed (heights still backfilling are simply absent). Window is capped at ~600
// by the backend. This is the primary data source for the isometric scroller.
export function fetchBlocksRange(
  from: number,
  to: number,
  chain?: Side,
  signal?: AbortSignal,
  fresh = false,
): Promise<BlocksRange> {
  const params = new URLSearchParams();
  params.set('from', String(Math.max(0, Math.floor(from))));
  params.set('to', String(Math.max(0, Math.floor(to))));
  if (chain) params.set('chain', chain);
  return getJson<BlocksRange>(`${API_BASE}/blocks/range?${params.toString()}`, signal, fresh);
}

export function fetchViolations(
  hash: string,
  signal?: AbortSignal,
): Promise<ViolationsResponse> {
  return getJson<ViolationsResponse>(
    `${API_BASE}/blocks/${encodeURIComponent(hash)}/violations`,
    signal,
  );
}
