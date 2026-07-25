#!/usr/bin/env node
/**
 * Diff two saved profiler runs — the before/after of a code change.
 *
 * profile.mjs compares variants WITHIN one run (same build, different URL/CSS). This compares the
 * same variant ACROSS two runs, which is what you want once the change is actually written:
 *
 *   ./bench.sh idle --out-name before      # on master
 *   ...make the change, rebuild...
 *   ./bench.sh idle --out-name after
 *   node compare.mjs out/before.json out/after.json
 *
 * Runs must share a scenario and viewport to be comparable; mismatches are reported, not silently
 * differenced. Only variants present in both files are shown.
 *
 * Every metric here is "lower is better" except fps, which is flagged so an improvement never prints
 * as a regression.
 */

import fs from 'node:fs';

const METRICS = [
  ['ms/frame', (r) => r.cpuMsFrame, false],
  ['main/frame', (r) => r.mainMsFrame, false],
  ['fps', (r) => r.fps, true],
  ['jank%', (r) => r.jankPct, false],
  ['p95 frame ms', (r) => r.p95Ms, false],
  ['layer MB', (r) => r.layerMemMB, false],
  ['layers', (r) => r.layerCount, false],
  ['rss MB', (r) => r.proc && (r.proc.rendererRssMB + r.proc.gpuRssMB + r.proc.browserRssMB), false],
  ['renderer cpu%', (r) => r.proc?.rendererCpuPct, false],
  ['gpu cpu%', (r) => r.proc?.gpuCpuPct, false],
  ['style%', (r) => r.stylePct, false],
  ['script%', (r) => r.scriptPct, false],
  ['layout%', (r) => r.layoutPct, false],
];

/** Below this relative change a difference is called flat — run-to-run noise here is a few percent,
 *  and labelling noise as a win is how a perf "fix" gets shipped that did nothing. */
const NOISE = 0.05;

function verdict(before, after, higherIsBetter) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return ['', '   -  '];
  const rel = (after - before) / Math.abs(before);
  if (Math.abs(rel) < NOISE) return ['flat', `${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(0)}%`];
  const better = higherIsBetter ? rel > 0 : rel < 0;
  return [better ? 'better' : 'WORSE', `${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(0)}%`];
}

function main() {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) {
    process.stderr.write('usage: compare.mjs <before.json> <after.json>\n');
    process.exit(2);
  }
  const A = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const B = JSON.parse(fs.readFileSync(bPath, 'utf8'));

  const warn = [];
  if (A.scenario !== B.scenario) warn.push(`scenario: ${A.scenario} vs ${B.scenario}`);
  if (A.viewport !== B.viewport) warn.push(`viewport: ${A.viewport} vs ${B.viewport}`);
  if (A.base !== B.base) warn.push(`base: ${A.base} vs ${B.base}`);

  process.stdout.write(`\nbefore  ${aPath}  (${A.scenario}, ${A.viewport}, ${A.seconds}s x${A.repeat}, ${A.at})\n`);
  process.stdout.write(`after   ${bPath}  (${B.scenario}, ${B.viewport}, ${B.seconds}s x${B.repeat}, ${B.at})\n`);
  if (warn.length) {
    // Not fatal: sometimes you deliberately compare across viewports. But it must never pass unnoticed.
    process.stdout.write(`\n!! these runs are not like-for-like — ${warn.join('; ')}\n`);
  }

  const byLabel = (r) => new Map(r.results.map((x) => [x.label, x]));
  const ma = byLabel(A);
  const mb = byLabel(B);
  const shared = [...ma.keys()].filter((k) => mb.has(k));
  if (shared.length === 0) {
    process.stdout.write('\nno variants in common between these runs\n');
    return;
  }
  const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
  const onlyB = [...mb.keys()].filter((k) => !ma.has(k));

  for (const label of shared) {
    const a = ma.get(label);
    const b = mb.get(label);
    process.stdout.write(`\n${label}${a.suffix ? `  (${a.suffix})` : ''}\n`);
    process.stdout.write(`  ${'metric'.padEnd(15)}${'before'.padStart(10)}${'after'.padStart(10)}${'change'.padStart(9)}  \n`);
    for (const [name, get, higherIsBetter] of METRICS) {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) continue;
      const [tag, pctStr] = verdict(va, vb, higherIsBetter);
      const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
      process.stdout.write(
        `  ${name.padEnd(15)}${fmt(va).padStart(10)}${fmt(vb).padStart(10)}${pctStr.padStart(9)}  ${tag}\n`,
      );
    }
  }
  if (onlyA.length || onlyB.length) {
    process.stdout.write(`\nskipped (not in both): ${[...onlyA, ...onlyB].join(', ')}\n`);
  }
  process.stdout.write('\n');
}

main();
