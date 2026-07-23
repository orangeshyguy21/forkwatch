// Seven-segment countdown display, in the style of an old radio alarm clock / NERV console: each
// digit is drawn from seven bars whose ends are cut at 45°, so that neighbouring bars mitre into a
// clean 90° corner. Unlit segments stay faintly visible — that ghosting is what makes it read as a
// physical LCD panel rather than a font.
//
// Drawn as SVG polygons rather than a webfont so the bar thickness, chamfer and gaps are ours to
// tune, and so lit/unlit can cross-fade per segment.

import { clsx } from '../util';

/** Digit cell geometry, in viewBox units. */
const W = 64;
const H = 108;
const PAD = 4;
/** Bar thickness. Half of it is also the length of each 45° chamfer. */
const T = 12;
/** Gap left between the tips of two bars meeting at a corner. */
const GAP = 2;

const HALF = T / 2;
const X_LEFT = PAD + HALF;
const X_RIGHT = W - PAD - HALF;
const Y_TOP = PAD + HALF;
const Y_MID = H / 2;
const Y_BOT = H - PAD - HALF;

const pts = (p: Array<[number, number]>) => p.map(([x, y]) => `${x},${y}`).join(' ');

/** Horizontal bar, tips at x0 and x1, chamfered both ends. */
function hBar(y: number, x0 = X_LEFT + GAP, x1 = X_RIGHT - GAP): string {
  return pts([
    [x0, y],
    [x0 + HALF, y - HALF],
    [x1 - HALF, y - HALF],
    [x1, y],
    [x1 - HALF, y + HALF],
    [x0 + HALF, y + HALF],
  ]);
}

/** Vertical bar, tips at y0 and y1, chamfered both ends. */
function vBar(x: number, y0: number, y1: number): string {
  return pts([
    [x, y0],
    [x + HALF, y0 + HALF],
    [x + HALF, y1 - HALF],
    [x, y1],
    [x - HALF, y1 - HALF],
    [x - HALF, y0 + HALF],
  ]);
}

// Standard segment naming: a top, b top-right, c bottom-right, d bottom, e bottom-left,
// f top-left, g middle.
const SEG: Record<string, string> = {
  a: hBar(Y_TOP),
  b: vBar(X_RIGHT, Y_TOP + GAP, Y_MID - GAP),
  c: vBar(X_RIGHT, Y_MID + GAP, Y_BOT - GAP),
  d: hBar(Y_BOT),
  e: vBar(X_LEFT, Y_MID + GAP, Y_BOT - GAP),
  f: vBar(X_LEFT, Y_TOP + GAP, Y_MID - GAP),
  g: hBar(Y_MID),
};

const DIGITS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

const ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

function Digit({ char }: { char: string }) {
  const on = DIGITS[char] ?? '';
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-auto shrink-0"
      role="img"
      aria-label={char}
    >
      {ORDER.map((s) => {
        const lit = on.includes(s);
        return (
          <polygon
            key={s}
            points={SEG[s]}
            fill="currentColor"
            className={clsx(
              'transition-opacity duration-150 ease-out',
              lit ? 'opacity-100' : 'opacity-[0.07]',
            )}
          />
        );
      })}
    </svg>
  );
}

/**
 * Colon separator — two square pips with their corners cut at 45°, so they speak the same language
 * as the bars. Sits at the thirds of the digit height, as on a real clock panel.
 */
function Colon() {
  const C = 3; // corner chamfer
  const pip = (cy: number) =>
    pts([
      [-HALF + C, cy - HALF],
      [HALF - C, cy - HALF],
      [HALF, cy - HALF + C],
      [HALF, cy + HALF - C],
      [HALF - C, cy + HALF],
      [-HALF + C, cy + HALF],
      [-HALF, cy + HALF - C],
      [-HALF, cy - HALF + C],
    ]);
  const span = Y_BOT - Y_TOP;
  return (
    <svg
      viewBox={`${-HALF - 1} 0 ${T + 2} ${H}`}
      className="h-full w-auto shrink-0"
      aria-hidden="true"
    >
      <polygon points={pip(Y_TOP + span / 3)} fill="currentColor" />
      <polygon points={pip(Y_TOP + (2 * span) / 3)} fill="currentColor" />
    </svg>
  );
}

/** Height of the digit row itself. The unit label sits below it, outside this box. */
const ROW = 'h-14 sm:h-[4.5rem]';

/**
 * Plus sign in the same chamfered-bar language as the digits — a seven-segment panel has no "+"
 * glyph, so we mint one from the hBar/vBar primitives. Rides at digit mid-height in a narrower
 * cell than a digit, since it is punctuation, not a numeral.
 */
function PlusGlyph() {
  const cx = W / 2;
  const cy = H / 2;
  const L = 20; // half-span of each bar
  return (
    <svg viewBox={`${cx - 26} 0 52 ${H}`} className="h-full w-auto shrink-0" aria-hidden="true">
      <polygon points={hBar(cy, cx - L, cx + L)} fill="currentColor" />
      <polygon points={vBar(cx, cy - L, cy + L)} fill="currentColor" />
    </svg>
  );
}

/**
 * A single chamfered bar — the split divider. Between two branch counters it reads as the tear
 * itself; colour it via className (the split wears red). Inset from the digit height at both ends:
 * a full-height centred bar sits exactly where a ghost "1" would, and got read as one.
 */
export function SegmentBar({ className }: { className?: string }) {
  const inset = 16;
  return (
    <div className={clsx(ROW, GLOW, className)}>
      <svg viewBox={`0 0 20 ${H}`} className="h-full w-auto shrink-0" aria-hidden="true">
        <polygon points={vBar(10, Y_TOP + inset, Y_BOT - inset)} fill="currentColor" />
      </svg>
    </div>
  );
}

/** A labelled group of digits (e.g. `19` / DAYS), optionally led by a plus sign. */
function Group({ value, label, plus }: { value: string; label: string; plus?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={clsx('flex items-stretch gap-[3px]', ROW)}>
        {plus && <PlusGlyph />}
        {value.split('').map((c, i) => (
          <Digit key={i} char={c} />
        ))}
      </div>
      <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">{label}</span>
    </div>
  );
}

/** The backlit-panel glow, shared by every segment readout. Rides on currentColor. */
const GLOW = '[filter:drop-shadow(0_0_10px_currentColor)]';

/**
 * A bare number in the same segment style as the clock — used for the block count, so the countdown
 * keeps one visual language when it drops the clock. No thousands separator: a segment panel has no
 * glyph for one, and the counts it shows at that point are small.
 */
export function SegmentNumber({
  value,
  label,
  className,
  plus,
}: {
  value: number;
  label: string;
  className?: string;
  /** Lead with a chamfered plus sign — for delta counts (+10 since the split). */
  plus?: boolean;
}) {
  return (
    <div className={clsx('flex items-start justify-center', GLOW, className)}>
      <Group value={String(Math.max(0, Math.floor(value)))} label={label} plus={plus} />
    </div>
  );
}

interface Props {
  seconds: number;
  /** Tailwind text colour class — the segments inherit it via currentColor. */
  className?: string;
}

export function SegmentClock({ seconds, className }: Props) {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');

  return (
    <div
      className={clsx(
        'flex items-start justify-center gap-2 sm:gap-3',
        GLOW,
        className,
      )}
    >
      {/* Days grow past two digits on a long countdown; hours/minutes/seconds never do. */}
      <Group value={days > 99 ? String(days) : p(days)} label="days" />
      <div className={ROW}>
        <Colon />
      </div>
      <Group value={p(hrs)} label="hrs" />
      <div className={ROW}>
        <Colon />
      </div>
      <Group value={p(mins)} label="min" />
      <div className={ROW}>
        <Colon />
      </div>
      <Group value={p(secs)} label="sec" />
    </div>
  );
}
