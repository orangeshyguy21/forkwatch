// Same-origin REST client for the Forkwars backend.
import type { BlocksPage, BlocksRange, ChainState, ViolationsResponse } from './types';

const API_BASE = '/api';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Request failed ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

export function fetchState(signal?: AbortSignal): Promise<ChainState> {
  return getJson<ChainState>(`${API_BASE}/state`, signal);
}

export function fetchBlocks(
  opts: { before?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<BlocksPage> {
  const params = new URLSearchParams();
  if (typeof opts.before === 'number') params.set('before', String(opts.before));
  params.set('limit', String(opts.limit ?? 30));
  const qs = params.toString();
  return getJson<BlocksPage>(`${API_BASE}/blocks?${qs}`, signal);
}

// Blocks present in the inclusive height range [from, to], ascending. Gaps are
// allowed (heights still backfilling are simply absent). Window is capped at ~600
// by the backend. This is the primary data source for the isometric scroller.
export function fetchBlocksRange(
  from: number,
  to: number,
  chain?: 'core' | 'knots',
  signal?: AbortSignal,
): Promise<BlocksRange> {
  const params = new URLSearchParams();
  params.set('from', String(Math.max(0, Math.floor(from))));
  params.set('to', String(Math.max(0, Math.floor(to))));
  if (chain) params.set('chain', chain);
  return getJson<BlocksRange>(`${API_BASE}/blocks/range?${params.toString()}`, signal);
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
