// The race rail: a 1D racetrack under the header hero that IS the two-node relationship.
//
// One chain → one quiet line with a single shared tip dot. One node lagging → a trailing dot and
// the gap it must close. A split → the rail breaks at the fork height and continues as TWO prongs,
// drawn square (bus-bar style: a vertical riser, then right-angle branches) rather than a Y — the
// same right-angle language as the seven-segment clock above it. Prong length is honest: it scales
// with how many blocks each side has mined since the split.
//
// Drawn in a fixed 800×46 viewBox and scaled to the header width; positions below are in those
// units. Colours match the chain view: cyan = the Core/majority lane, slate = the Knots lane,
// emerald = agreement, sky = merely syncing, amber = tip rejected, red = the split itself.

import type { ChainState } from '../types';
import { formatInt } from '../util';

const CENTER_X = 400;
const MID_Y = 23;
const TOP_Y = 9;
const BOT_Y = 37;

/** Prong length for `ahead` blocks, relative to the longer side. Keeps labels inside the box. */
function prongLen(ahead: number, maxAhead: number): number {
  return 40 + 200 * (Math.max(0, ahead) / Math.max(1, maxAhead));
}

function Rail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 800 46"
      role="img"
      aria-label={label}
      className="mx-auto mt-1 block w-full max-w-3xl"
    >
      {children}
    </svg>
  );
}

function RailText({
  x,
  y,
  fill,
  anchor,
  children,
}: {
  x: number;
  y: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  children: React.ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor ?? 'start'}
      fill={fill}
      fontSize={9.5}
      fontWeight={700}
      letterSpacing="0.06em"
      className="font-mono tabular-nums"
    >
      {children}
    </text>
  );
}

export function RaceRail({ state }: { state: ChainState }) {
  const coreH = state.core?.blocks ?? 0;
  const knotsH = state.knots?.blocks ?? 0;

  // -------- SPLIT: the rail forks, square --------
  if (state.split) {
    const at = state.fork?.at_height ?? state.lca_height ?? 0;
    const coreA = Math.max(0, coreH - at);
    const knotsA = Math.max(0, knotsH - at);
    const maxA = Math.max(coreA, knotsA);
    const lc = prongLen(coreA, maxA);
    const lk = prongLen(knotsA, maxA);
    return (
      <Rail label={`Chain split at ${formatInt(at)}: non-signaling ${coreA} ahead, signaling ${knotsA} ahead`}>
        {/* the one chain, up to the fork height */}
        <line x1={40} y1={MID_Y} x2={CENTER_X} y2={MID_Y} stroke="rgba(248,113,113,0.35)" strokeWidth={2} />
        {/* square fork: vertical riser, then right-angle prongs */}
        <line x1={CENTER_X} y1={TOP_Y} x2={CENTER_X} y2={BOT_Y} stroke="rgba(248,113,113,0.6)" strokeWidth={2} strokeLinecap="square" />
        <line x1={CENTER_X} y1={TOP_Y} x2={CENTER_X + lc} y2={TOP_Y} stroke="rgba(103,232,249,0.75)" strokeWidth={2} strokeLinecap="square" />
        <line x1={CENTER_X} y1={BOT_Y} x2={CENTER_X + lk} y2={BOT_Y} stroke="rgba(148,163,184,0.7)" strokeWidth={2} strokeLinecap="square" />
        <circle cx={CENTER_X + lc} cy={TOP_Y} r={3.5} fill="#67e8f9" />
        <circle cx={CENTER_X + lk} cy={BOT_Y} r={3.5} fill="#94a3b8" />
        <circle cx={CENTER_X} cy={MID_Y} r={4.5} fill="#f87171" />
        {/* Tip heights only. The stances live on the flanking panels and the "+N / +N" score is
            the hero's — the rail's job is the geometry. */}
        <RailText x={CENTER_X + lc + 10} y={TOP_Y + 3} fill="#67e8f9">
          {formatInt(coreH)}
        </RailText>
        <RailText x={CENTER_X + lk + 10} y={BOT_Y + 4} fill="#94a3b8">
          {formatInt(knotsH)}
        </RailText>
        <RailText x={CENTER_X - 12} y={BOT_Y + 4} fill="#f87171" anchor="end">
          ⑂ {formatInt(at)}
        </RailText>
      </Rail>
    );
  }

  // -------- REJECTED: no rival block yet, but the handshake is over --------
  if (state.rejected) {
    return (
      <Rail label="Knots rejects the core tip">
        <line x1={40} y1={MID_Y} x2={760} y2={MID_Y} stroke="rgba(251,191,36,0.18)" strokeWidth={2} />
        <circle cx={430} cy={MID_Y} r={3.5} fill="#f4f4f5" />
        <circle cx={370} cy={MID_Y} r={5.5} fill="none" stroke="#fbbf24" strokeWidth={1.5} />
        <RailText x={370} y={MID_Y + 3} fill="#fbbf24" anchor="middle">
          ✕
        </RailText>
        <RailText x={370} y={BOT_Y + 4} fill="#fbbf24" anchor="middle">
          signaling {formatInt(knotsH)} · rejects tip
        </RailText>
        <RailText x={430} y={TOP_Y + 1} fill="#a1a1aa" anchor="middle">
          non-signaling {formatInt(coreH)}
        </RailText>
      </Rail>
    );
  }

  // -------- SYNCING: one node trails on the same chain --------
  if (state.syncing) {
    const behind = Math.abs(coreH - knotsH);
    const knotsBehind = knotsH < coreH;
    const gap = Math.min(110, 30 + behind * 6);
    const lead = 430;
    const trail = lead - gap;
    return (
      <Rail label={`${knotsBehind ? 'Knots' : 'Core'} is ${behind} blocks behind`}>
        <line x1={40} y1={MID_Y} x2={760} y2={MID_Y} stroke="rgba(125,211,252,0.18)" strokeWidth={2} />
        <line x1={trail} y1={MID_Y} x2={lead} y2={MID_Y} stroke="rgba(125,211,252,0.6)" strokeWidth={2} strokeDasharray="5 5" />
        <circle cx={trail} cy={MID_Y} r={3.5} fill="#7dd3fc" />
        <circle cx={lead} cy={MID_Y} r={3.5} fill="#f4f4f5" />
        <RailText x={(trail + lead) / 2} y={TOP_Y + 1} fill="#7dd3fc" anchor="middle">
          −{formatInt(behind)}
        </RailText>
        {/* Labels anchor OUTWARD from their dots — at a 1-block gap the dots nearly touch, and
            centred labels would type over each other. */}
        <RailText x={trail - 10} y={BOT_Y + 4} fill="#7dd3fc" anchor="end">
          {knotsBehind ? 'signaling' : 'non-signaling'} {formatInt(Math.min(coreH, knotsH))}
        </RailText>
        <RailText x={lead + 10} y={BOT_Y + 4} fill="#a1a1aa" anchor="start">
          {knotsBehind ? 'non-signaling' : 'signaling'} {formatInt(Math.max(coreH, knotsH))}
        </RailText>
      </Rail>
    );
  }

  // -------- AGREEMENT: one line, one shared tip --------
  return (
    <Rail label={`One chain, both tips at ${formatInt(state.tip_height)}`}>
      <line x1={40} y1={MID_Y} x2={760} y2={MID_Y} stroke="rgba(52,211,153,0.22)" strokeWidth={2} />
      <circle cx={CENTER_X} cy={MID_Y} r={8} fill="rgba(52,211,153,0.2)" />
      <circle cx={CENTER_X} cy={MID_Y} r={3.5} fill="#34d399" />
      <RailText x={CENTER_X} y={BOT_Y + 5} fill="#71717a" anchor="middle">
        one chain · both tips at {formatInt(state.tip_height)}
      </RailText>
    </Rail>
  );
}
