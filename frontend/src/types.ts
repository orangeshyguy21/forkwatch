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
  blocks_until: number;
  reached: boolean;
}

export interface ChainState {
  core: NodeInfo;
  knots: NodeInfo;
  agreed: boolean;
  syncing?: boolean;
  lca_height: number;
  tip_height: number;
  prune_floor?: number; // data floor: lowest height actually cached/servable
  floor_height?: number; // configured display floor (0 = none); rail spans [floor_height, tip]
  fork: ForkInfo | null;
  rdts: RdtsInfo;
  signaling: SignalingInfo;
  scheduled_fork?: ScheduledFork | null;
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

export type Side = 'core' | 'knots';
