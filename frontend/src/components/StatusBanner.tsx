import type { ChainState, NodeInfo, RdtsStatus, Side } from '../types';
import { clsx, formatInt } from '../util';

const RDTS_LABEL: Record<RdtsStatus, string> = {
  never: 'RDTS NOT DEPLOYED',
  defined: 'RDTS DEFINED',
  started: 'RDTS SIGNALING STARTED',
  locked_in: 'RDTS LOCKED IN',
  active: 'RDTS ACTIVE',
};

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={clsx(
        'inline-block h-2.5 w-2.5 rounded-full',
        online ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]' : 'bg-red-500',
      )}
      title={online ? 'online' : 'offline'}
    />
  );
}

function NodePill({ node, side }: { node: NodeInfo; side: Side }) {
  // The two sides are named honestly by RDTS signaling: Knots signals RDTS (the pro-RDTS camp), Core
  // does not. "RDTS" is left implicit — the header's RDTS badge + bit-4 gauge establish the context.
  // The node's client subversion is kept underneath as the source of truth.
  const stanceLabel = side === 'knots' ? 'SIGNALING' : 'NON-SIGNALING';
  return (
    <div
      data-side={side}
      className={clsx(
        'flex items-center gap-3 rounded-md border px-3.5 py-2',
        side === 'core'
          ? 'border-white/20 bg-white/[0.03] font-mono'
          : 'border-slate-400/40 bg-slate-400/[0.07]',
      )}
    >
      <OnlineDot online={!!node.online} />
      <div className="min-w-0">
        <div
          className={clsx(
            'text-xs font-bold uppercase tracking-wider',
            side === 'core' ? 'text-zinc-100' : 'text-slate-300',
          )}
        >
          {stanceLabel}
        </div>
        <div className="text-[10.5px] text-zinc-500">{node.version}</div>
      </div>
      <div className="ml-2 text-right">
        <div className="font-mono text-lg font-bold leading-none text-zinc-100 tabular-nums">
          {formatInt(node.blocks)}
        </div>
        <div className="text-[9px] uppercase tracking-widest text-zinc-600">height</div>
      </div>
    </div>
  );
}

function SignalGauge({ state }: { state: ChainState }) {
  const s = state.signaling;
  const pct = Number.isFinite(s?.pct) ? s.pct : 0;
  const threshold = Number.isFinite(s?.threshold_pct) ? s.threshold_pct : 55;
  const met = pct >= threshold;
  const clamped = Math.max(0, Math.min(100, pct));
  const thPos = Math.max(0, Math.min(100, threshold));
  // Display threshold at 1 decimal, dropping a trailing .0 — the raw value is a block-count ratio
  // (e.g. 1109/2016 = 55.00992…%), not a clean percentage.
  const thresholdLabel = (Math.round(threshold * 10) / 10).toString();

  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="uppercase tracking-wider text-zinc-500">bit-4 signaling</span>
        <span className={clsx('font-mono font-semibold', met ? 'text-emerald-300' : 'text-amber-300')}>
          {formatInt(s?.signaled ?? 0)}/{formatInt(s?.total ?? 0)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={clsx(
            'h-full rounded-full transition-all duration-500',
            met ? 'bg-emerald-400' : 'bg-amber-400',
          )}
          style={{ width: `${clamped}%` }}
        />
        {/* threshold marker */}
        <div
          className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-zinc-200"
          style={{ left: `${thPos}%` }}
          title={`threshold ${thresholdLabel}%`}
        />
      </div>
      <div className="mt-1 text-right text-[10px] text-zinc-500">
        threshold {thresholdLabel}% · window {formatInt(s?.window ?? 0)}
      </div>
    </div>
  );
}

interface Props {
  state: ChainState | null;
  error: string | null;
}

export function StatusBanner({ state, error }: Props) {
  if (!state) {
    return (
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/70 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <span className="text-lg font-bold tracking-tight text-zinc-100">FORKWATCH</span>
          <span className="text-sm text-zinc-500">
            {error ? `Connection error: ${error}` : 'Connecting to nodes…'}
          </span>
        </div>
      </header>
    );
  }

  const agreed = state.agreed;
  const forkedBy = Math.max(
    0,
    (state.tip_height ?? 0) - (state.lca_height ?? state.tip_height ?? 0),
    state.fork?.core_branch?.length ?? 0,
    state.fork?.knots_branch?.length ?? 0,
  );
  const rdts = state.rdts;
  const rdtsActive = rdts?.status === 'active';
  const syncing = !agreed && !!state.syncing;
  const sf = state.scheduled_fork;
  const showCountdown = agreed && !!sf && !sf.reached;

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-black/70 backdrop-blur">
      <div className="mx-auto max-w-6xl px-5 py-3">
        {/* Top row: brand + RDTS status + agreement indicator */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-black tracking-tight text-zinc-100">
              FORK<span className="text-emerald-400">WATCH</span>
            </span>
            <span
              className={clsx(
                'rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider',
                rdtsActive
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-white/20 bg-white/5 text-zinc-300',
              )}
              title={`RDTS status: ${rdts?.status ?? 'unknown'}`}
            >
              {rdtsActive
                ? `RDTS ACTIVE — since block ${formatInt(rdts.since_height)}`
                : RDTS_LABEL[rdts?.status ?? 'never']}
              {rdts?.bit != null && <span className="ml-1.5 opacity-70">bit {rdts.bit}</span>}
            </span>
          </div>

          {/* Big central status indicator: agreed / syncing / forked */}
          <div
            className={clsx(
              'rounded-lg border px-4 py-1.5 text-center',
              agreed
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : syncing
                  ? 'border-sky-500/40 bg-sky-500/10'
                  : 'animate-pulse-slow border-red-500/60 bg-red-500/15',
            )}
          >
            <div
              className={clsx(
                'text-base font-black uppercase tracking-[0.15em]',
                agreed ? 'text-emerald-300' : syncing ? 'text-sky-300' : 'text-red-300',
              )}
            >
              {agreed
                ? 'In Agreement'
                : syncing
                  ? 'Syncing'
                  : `Forked — ${forkedBy} block${forkedBy === 1 ? '' : 's'}`}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              {agreed
                ? `single chain · tip #${formatInt(state.tip_height)}`
                : syncing
                  ? `nodes catching up · core #${formatInt(state.core.blocks)} · knots #${formatInt(state.knots.blocks)}`
                  : `diverged at #${formatInt(state.lca_height)}`}
            </div>
          </div>
        </div>

        {/* Scheduled-fork countdown (regtest demo): watch the chain climb toward the fork */}
        {showCountdown && sf && (
          <div className="mt-2 flex items-center justify-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
            <span className="text-[11px] font-bold uppercase tracking-widest text-amber-300">
              ⚠ Fork scheduled at #{formatInt(sf.height)}
            </span>
            <span className="font-mono text-sm font-bold tabular-nums text-amber-200">
              — {formatInt(sf.blocks_until)} block{sf.blocks_until === 1 ? '' : 's'} to go
            </span>
          </div>
        )}

        {/* Bottom row: nodes + signaling gauge */}
        <div className="mt-3 grid grid-cols-1 items-center gap-3 md:grid-cols-[auto_1fr_auto]">
          <NodePill node={state.core} side="core" />
          <div className="px-1">
            <SignalGauge state={state} />
          </div>
          <NodePill node={state.knots} side="knots" />
        </div>

        {error && (
          <div className="mt-2 text-[11px] text-amber-400/80">
            Live update issue: {error} — retrying…
          </div>
        )}
      </div>
    </header>
  );
}
