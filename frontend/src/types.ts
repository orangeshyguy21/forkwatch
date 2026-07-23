// Type definitions mirroring the Forkwars backend API contract.

export type RdtsVerdict = 'pass' | 'would_violate' | 'invalid' | 'unscanned';

export type NodeBlockStatus =
  | 'active'
  | 'valid-fork'
  | 'invalid'
  | 'headers-only'
  | 'absent';

export interface Block {
  height: number;
  hash: string;
  prev_hash: string;
  time: number;
  size: number;
  weight: number;
  tx_count: number;
  version: number;
  signals_110: boolean;
  rdts_verdict: RdtsVerdict;
  rdts_rule_hits: number[];
  miner: string | null;
  coinbase_tag: string | null;
  core_status: NodeBlockStatus;
  knots_status: NodeBlockStatus;
}

export interface NodeInfo {
  label: string;
  version: string;
  blocks: number;
  bestblockhash: string;
  connections: number;
  online: boolean;
}

export type RdtsStatus = 'never' | 'defined' | 'started' | 'locked_in' | 'active';

export interface RdtsInfo {
  status: RdtsStatus;
  since_height: number;
  bit: number;
}

export interface SignalingInfo {
  window: number;
  signaled: number;
  total: number;
  pct: number;
  threshold_pct: number;
}

export interface ForkInfo {
  at_height: number;
  core_branch: Block[];
  knots_branch: Block[];
  knots_view_of_core_tip: string;
}

export interface ScheduledFork {
  height: number;
  /** What this height *is* — differs by network, so the backend names it. */
  label: string | null;
  blocks_until: number;
  /** True once an actual split occurs, or the target height is passed. Not merely disagreement. */
  reached: boolean;
}

export interface Pacing {
  /** Protocol target block interval, seconds. Null where retargeting does not bind (regtest). */
  target_spacing: number | null;
  /** Blocks per difficulty epoch (mainnet 2016). */
  retarget_interval: number;
  /** First height mined under the *next* difficulty. Null if unknown. */
  next_retarget_height: number | null;
}

export interface ChainState {
  core: NodeInfo;
  knots: NodeInfo;
  agreed: boolean;
  /** One node is simply behind on the same chain. Not a split. */
  syncing?: boolean;
  /** Both nodes hold a block at the same height with different hashes. THIS is a chain split. */
  split?: boolean;
  /** Knots has rejected Core's tip but has not yet produced a competing block at that height. */
  rejected?: boolean;
  lca_height: number;
  tip_height: number;
  prune_floor?: number; // data floor: lowest height actually cached/servable
  floor_height?: number; // configured display floor (0 = none); rail spans [floor_height, tip]
  fork: ForkInfo | null;
  rdts: RdtsInfo;
  signaling: SignalingInfo;
  scheduled_fork?: ScheduledFork | null;
  pacing?: Pacing | null;
}

export interface BlocksPage {
  blocks: Block[];
  has_more: boolean;
}

export interface BlocksRange {
  blocks: Block[];
  tip_height: number;
  prune_floor: number;
}

export interface Violation {
  rule: number;
  kind: string;
  count: number;
}

export interface ViolationsResponse {
  hash: string;
  violations: Violation[];
}

/** WebSocket push frame. The backend sends the payload itself rather than a bare notification, so a
 *  new block costs the client zero HTTP requests. `state`/`blocks` are absent only in the frame sent
 *  to a client that connects before ingest has completed its first poll — that case falls back to
 *  fetching over HTTP. `blocks` carries the newest few blocks on the Core chain, tip-first. */
export interface PushFrame {
  type: 'update';
  state?: ChainState;
  blocks?: Block[];
}

export type Side = 'core' | 'knots';
