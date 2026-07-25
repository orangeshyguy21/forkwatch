#!/usr/bin/env node
/**
 * Forkwatch client-resource profiler.
 *
 * Runs the app in headless Chromium and samples, per variant, what it costs the client while the
 * page just sits there (or while you fly the chain). Built to A/B a change, not to produce absolute
 * truth: the numbers below are only meaningful against another run of this same harness.
 *
 * WHAT IT MEASURES, and why each one is here — the whole point is that the three cost centres are
 * separable, because they are fixed in completely different ways:
 *
 *   main-thread CPU   (renderer process, /proc)  — React, rAF callbacks, style, layout
 *   compositor/raster CPU (gpu process, /proc)   — layers, masks, blend modes, big repaints
 *   frame health      (in-page rAF timestamps)   — what the user actually feels
 *
 * `Performance.getMetrics` splits the renderer's own time into Script / Layout / RecalcStyle, which
 * tells you *which* of those to go after. A change that halves ScriptDuration but leaves gpu-process
 * CPU flat did nothing for a client whose cost is compositing — that mistake is the reason the
 * gpu-process column exists.
 *
 * HEADLESS CAVEAT. There is no real GPU here: Chromium rasterizes through SwiftShader on the CPU, so
 * the gpu-process figure is *software* raster and will be far higher than a real client's. That is
 * useful rather than not — it turns compositing into a number you can see — but treat it as a
 * sensitive relative index of compositor work, never as "users burn this many cores".
 *
 * Variants are just URL suffixes, so the app's existing debug params are the benchmark axes:
 *   ?bg=off|lattice|field|both   backdrop pieces (see Backdrop.tsx)
 *   ?zoom=0..4                   camera detent — decides how many blocks are on screen
 *   ?focus=<h>                   park at a height instead of the tip
 *
 * Usage (see bench.sh, which wraps the docker invocation):
 *   node profile.mjs --base http://127.0.0.1:8080 \
 *     --variant 'full:' --variant 'bg-off:?bg=off' \
 *     --scenario idle --seconds 12 --repeat 3 --out /out/run.json
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:8080',
    variants: [],
    scenario: 'idle',
    seconds: 12,
    settle: 4,
    repeat: 3,
    width: 1440,
    height: 900,
    dpr: 1,
    reducedMotion: false,
    /**
     * Drop the rAF frame probe.
     *
     * The probe is a frame REQUESTER as much as a frame observer: its loop obliges the browser to
     * produce frames continuously, which is harmless when the page was going to do that anyway but
     * completely masks a page that has learned to go quiet. Measuring the parking fix with the probe
     * on reported 27% CPU; with it off, the same build costs 7%. Use this whenever the question is
     * "does this page idle?" — it trades the fps/jank columns for an honest CPU number.
     */
    noProbe: false,
    out: null,
    json: false,
    css: new Map(),
    js: new Map(),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base': out.base = next(); break;
      case '--variant': out.variants.push(next()); break;
      case '--scenario': out.scenario = next(); break;
      case '--seconds': out.seconds = +next(); break;
      case '--settle': out.settle = +next(); break;
      case '--repeat': out.repeat = +next(); break;
      case '--width': out.width = +next(); break;
      case '--height': out.height = +next(); break;
      case '--dpr': out.dpr = +next(); break;
      case '--reduced-motion': out.reducedMotion = true; break;
      case '--no-probe': out.noProbe = true; break;
      case '--out': out.out = next(); break;
      case '--json': out.json = true; break;
      case '--css': { const s = next(); const i = s.indexOf('='); out.css.set(s.slice(0, i), s.slice(i + 1)); break; }
      case '--js': { const s = next(); const i = s.indexOf('='); out.js.set(s.slice(0, i), s.slice(i + 1)); break; }
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (out.variants.length === 0) out.variants.push('default:');
  return out;
}

/**
 * `label:suffix` — the suffix is appended to --base verbatim (so it carries the `?`).
 *
 * A suffix that is itself an absolute URL replaces --base instead, which is what lets two different
 * BUILDS be compared: serve before/after bundles on two ports and hand both to one run, so they are
 * interleaved round-robin under identical conditions rather than measured minutes apart.
 */
function splitVariant(spec) {
  const i = spec.indexOf(':');
  if (i < 0) return { label: spec || 'default', suffix: '' };
  return { label: spec.slice(0, i) || 'default', suffix: spec.slice(i + 1) };
}

const urlFor = (base, suffix) => (/^https?:\/\//.test(suffix) ? suffix : base + suffix);

// ---------------------------------------------------------------------------
// /proc CPU sampling — per Chromium process class
// ---------------------------------------------------------------------------

/**
 * Chromium splits the work we care about across processes, and the split IS the diagnosis: a
 * renderer-heavy profile is a JS/layout problem, a gpu-heavy one is a layers/paint problem. Reading
 * /proc directly (rather than trusting a whole-container number) keeps the profiler's own node
 * process out of the measurement.
 */
const CLK_TCK = 100; // Linux default; only ever used to turn jiffy deltas into seconds

function classify(cmdline) {
  if (!/chrom/i.test(cmdline)) return null;
  const m = /--type=([a-z-]+)/.exec(cmdline);
  if (!m) return 'browser';
  const t = m[1];
  if (t === 'renderer') return 'renderer';
  if (t === 'gpu-process') return 'gpu';
  if (t === 'zygote') return null; // idle by definition, and it forks everything else — pure noise
  return 'other';
}

/** Total CPU jiffies + peak RSS per process class, right now. */
function procSnapshot() {
  const cpu = { browser: 0, renderer: 0, gpu: 0, other: 0 };
  const rss = { browser: 0, renderer: 0, gpu: 0, other: 0 };
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return null; // not on Linux / no procfs — the CPU columns just get dropped
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline, stat;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue; // process exited between readdir and read — normal, chromium churns helpers
    }
    const kind = classify(cmdline.replace(/\0/g, ' '));
    if (!kind) continue;
    // comm (field 2) is parenthesised and may itself contain spaces/parens, so split after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = +rest[11]; // field 14
    const stime = +rest[12]; // field 15
    const rssPages = +rest[21]; // field 24
    cpu[kind] += utime + stime;
    rss[kind] += rssPages * 4096;
  }
  return { cpu, rss, at: Date.now() };
}

/** CPU-seconds per class between two snapshots, plus % of one core over the wall window. */
function procDelta(a, b) {
  if (!a || !b) return null;
  const wall = (b.at - a.at) / 1000;
  const out = { wallSec: wall };
  for (const k of ['browser', 'renderer', 'gpu', 'other']) {
    const sec = (b.cpu[k] - a.cpu[k]) / CLK_TCK;
    out[`${k}CpuPct`] = wall > 0 ? (sec / wall) * 100 : 0;
    out[`${k}RssMB`] = b.rss[k] / 1048576;
  }
  out.totalCpuPct = out.browserCpuPct + out.rendererCpuPct + out.gpuCpuPct + out.otherCpuPct;
  return out;
}

// ---------------------------------------------------------------------------
// in-page instrumentation
// ---------------------------------------------------------------------------

/**
 * Installed before any app code runs. Records rAF timestamps and long tasks into a plain array;
 * everything is reduced in node afterwards so the page-side cost stays at one array push per frame.
 */
const pageProbe = (withRaf) => `
window.__fwperf = { frames: [], longTasks: [] };
(function () {
  // The frame probe is itself a frame REQUESTER, so it is omitted for the quiesce scenario — there
  // it would force the very frame production that scenario exists to remove.
  if (${withRaf}) {
    const f = (t) => { window.__fwperf.frames.push(t); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__fwperf.longTasks.push([e.startTime, e.duration]);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* longtask unsupported — the frame stats still stand on their own */ }
})();
`;

/**
 * Stop the page asking for frames at all: neuter rAF (loops re-register through it, so they die
 * after the current frame) and halt every CSS animation and transition, which drive the compositor
 * on their own. What remains is the cost of simply HAVING the page open, at rest.
 *
 * The gap between this and the idle scenario is the per-frame cost — and that gap is the finding
 * this whole harness was built to produce: the backdrop's layers cost ~nothing at rest (gpu 3%) and
 * ~100% of a core when frames flow, because the app never stops requesting them.
 */
const QUIESCE = () => {
  window.requestAnimationFrame = () => 0;
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
  document.head.appendChild(st);
};

/** Appends a <style> once the document has a head to hang it off. */
const INJECT_CSS = (rules) => {
  const add = () => {
    const el = document.createElement('style');
    el.textContent = rules;
    document.head.appendChild(el);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add);
};

/** Frame-interval stats over the measurement window only (frames outside it are discarded). */
function frameStats(frames, t0, t1) {
  const win = frames.filter((t) => t >= t0 && t <= t1);
  const gaps = [];
  for (let i = 1; i < win.length; i++) gaps.push(win[i] - win[i - 1]);
  if (gaps.length === 0) return { fps: 0, frames: 0, p95Ms: 0, worstMs: 0, jankPct: 0 };
  const sorted = [...gaps].sort((x, y) => x - y);
  const span = (win[win.length - 1] - win[0]) / 1000;
  return {
    fps: span > 0 ? (win.length - 1) / span : 0,
    frames: win.length,
    // A dropped frame at 60Hz is anything past ~one and a half refreshes.
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    worstMs: sorted[sorted.length - 1],
    jankPct: (gaps.filter((g) => g > 25).length / gaps.length) * 100,
  };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What the page is doing while we sample.
 *
 *   idle    — untouched. THE case that matters: a wall display left open. Anything burning CPU here
 *             is burning it forever. (On regtest, blocks still arrive, so spawn animations land in
 *             this window too — that is realistic, and it is why repeats are interleaved.)
 *   scroll  — a sustained fly through history: wheel bursts, reversing before hitting the ends.
 *             Exercises the per-frame React path (every visible block re-renders) and the zoom spring.
 *   quiesce — the page is up but asks for no frames at all (see QUIESCE). The at-rest floor: layer
 *             memory and whatever runs on timers. `idle` minus `quiesce` is the per-frame cost, and
 *             that subtraction is the most diagnostic thing here — a big gap means the page is
 *             paying to redraw something nobody asked it to redraw.
 *   hidden  — tab backgrounded. UNRELIABLE HEADLESS: setPageVisibilityOverride does not actually
 *             throttle rAF here, so it currently reports the same numbers as `idle`. Use `quiesce`
 *             for the question this was meant to answer.
 */
async function runScenario(page, scenario, ms) {
  if (scenario === 'idle') return sleep(ms);
  if (scenario === 'quiesce') {
    await page.evaluate(QUIESCE);
    await sleep(1500); // let in-flight frames drain before the window opens
    return sleep(ms);
  }
  if (scenario === 'hidden') {
    const session = await page.createCDPSession();
    // rAF only throttles for a genuinely hidden page; emulation is the only way to get there headless.
    await session.send('Emulation.setPageVisibilityOverride', { visibility: 'hidden' }).catch(() => {});
    await sleep(ms);
    await session.send('Emulation.setPageVisibilityOverride', { visibility: 'visible' }).catch(() => {});
    await session.detach().catch(() => {});
    return;
  }
  if (scenario === 'scroll') {
    const vp = page.viewport();
    const x = Math.round(vp.width / 2);
    const y = Math.round(vp.height / 2);
    await page.mouse.move(x, y);
    const end = Date.now() + ms;
    let dir = 1;
    let sinceFlip = 0;
    while (Date.now() < end) {
      // A real wheel gesture is a burst of notches, not one big delta — and the scroller's
      // acceleration ramp (SCROLL_ACCEL_STEP) only engages on consecutive same-direction ticks,
      // so bursts are what actually reaches top speed.
      for (let i = 0; i < 4 && Date.now() < end; i++) {
        await page.mouse.wheel({ deltaY: 120 * dir });
        await sleep(16);
      }
      await sleep(60);
      sinceFlip += 4 * 16 + 60;
      // Reverse well before the chain runs out of blocks, so we measure flying, not sitting at a wall.
      if (sinceFlip > 2500) { dir = -dir; sinceFlip = 0; }
    }
    return;
  }
  throw new Error(`unknown scenario: ${scenario}`);
}

// ---------------------------------------------------------------------------
// one measurement
// ---------------------------------------------------------------------------

const METRIC_KEYS = [
  'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
  'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes', 'LayoutObjects',
];

function metricsToObj(list) {
  const o = {};
  for (const m of list) if (METRIC_KEYS.includes(m.name)) o[m.name] = m.value;
  return o;
}

async function measure(browser, url, opts, css, js) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr });
    if (opts.reducedMotion) {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    }
    await page.evaluateOnNewDocument(pageProbe(opts.scenario !== 'quiesce' && !opts.noProbe));
    // Per-variant CSS override, appended at document end so it wins on order against the app's own
    // rules. This is what lets a candidate fix be measured before it is written: switching off one
    // animation or one blend mode is a stylesheet away, and the alternative — rebuild, redeploy,
    // re-measure — is slow enough that nobody does the A/B at all.
    if (css) await page.evaluateOnNewDocument(INJECT_CSS, css);

    const session = await page.createCDPSession();
    await session.send('Performance.enable');

    /**
     * Composited layer census — the one compositor number that is NOT a property of this machine.
     *
     * CPU% for the gpu process is whatever the raster backend costs here (software, in headless), so
     * it saturates and cannot be compared to a real client. Layer count and total layer area are
     * structural: they come from the same compositing decisions on every device, they set GPU memory
     * (area × 4 bytes, held for as long as the page is open) and they set the per-frame fill the
     * compositor must do. A change that halves layer area halves that everywhere.
     */
    let layers = null;
    await session.send('LayerTree.enable').catch(() => {});
    session.on('LayerTree.layerTreeDidChange', (e) => {
      if (!e.layers) return;
      // Only layers that actually rasterize content cost memory and fill; the rest are transform nodes.
      const drawn = e.layers.filter((l) => l.drawsContent);
      layers = {
        count: drawn.length,
        areaMPx: drawn.reduce((a, l) => a + l.width * l.height, 0) / 1e6,
        memMB: drawn.reduce((a, l) => a + l.width * l.height * 4, 0) / 1048576,
      };
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Let the intro animation, the first WebSocket payload and the initial layout all finish — we are
    // profiling steady state, and the page-load intro is a one-off that would swamp a short window.
    await sleep(opts.settle * 1000);

    // Per-variant JS, run AFTER settle so it lands on steady state rather than racing the intro.
    // Where --css switches a style off, this prototypes behavioural changes — swapping the frame
    // scheduler, say — so a fix can be measured before anyone commits to writing it.
    if (js) await page.evaluate(js);
    if (js) await sleep(1500); // let in-flight frames drain before the window opens

    const p0 = procSnapshot();
    const m0 = metricsToObj((await session.send('Performance.getMetrics')).metrics);
    const t0 = await page.evaluate(() => performance.now());

    await runScenario(page, opts.scenario, opts.seconds * 1000);

    const t1 = await page.evaluate(() => performance.now());
    const m1 = metricsToObj((await session.send('Performance.getMetrics')).metrics);
    const p1 = procSnapshot();

    const probe = await page.evaluate(() => ({
      frames: window.__fwperf.frames,
      longTasks: window.__fwperf.longTasks,
    }));

    const wall = (t1 - t0) / 1000;
    const dur = (k) => ((m1[k] ?? 0) - (m0[k] ?? 0));
    const pct = (k) => (wall > 0 ? (dur(k) / wall) * 100 : 0);
    const longIn = probe.longTasks.filter(([s]) => s >= t0 && s <= t1);
    const fstats = frameStats(probe.frames, t0, t1);
    const proc = procDelta(p0, p1);

    /**
     * Cost PER FRAME, not per second.
     *
     * Per-second CPU is confounded by throughput, and confounded in the direction that flatters the
     * expensive variant: a page too slow to hit 60fps simply renders fewer frames, so it can post a
     * LOWER cpu% while feeling worse. Measured on the chain fly, switching the backdrop off doubled
     * the frame rate and thereby raised cpu% by 45% — which reads as a regression and is the exact
     * opposite of what happened. Dividing by frames actually delivered removes the confound: this is
     * the number to compare when frame rates differ between variants.
     */
    const perFrame = (pctVal) => (fstats.frames > 0 ? (pctVal / 100) * wall * 1000 / fstats.frames : 0);

    return {
      wallSec: wall,
      // Renderer main thread, split by what it was doing. TaskDuration is the total.
      mainThreadPct: pct('TaskDuration'),
      scriptPct: pct('ScriptDuration'),
      layoutPct: pct('LayoutDuration'),
      stylePct: pct('RecalcStyleDuration'),
      layoutsPerSec: (m1.LayoutCount - m0.LayoutCount) / wall,
      stylesPerSec: (m1.RecalcStyleCount - m0.RecalcStyleCount) / wall,
      heapMB: m1.JSHeapUsedSize / 1048576,
      nodes: m1.Nodes,
      layoutObjects: m1.LayoutObjects,
      longTasks: longIn.length,
      longTaskMsPerSec: longIn.reduce((a, [, d]) => a + d, 0) / wall,
      layerCount: layers?.count ?? null,
      layerAreaMPx: layers?.areaMPx ?? null,
      layerMemMB: layers?.memMB ?? null,
      ...fstats,
      // Throughput-independent cost. cpuMsFrame counts every chromium process; mainMsFrame is the
      // renderer main thread alone, which is the one a React change can move.
      cpuMsFrame: perFrame(proc?.totalCpuPct ?? 0),
      mainMsFrame: perFrame(pct('TaskDuration')),
      proc,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const median = (xs) => {
  const s = [...xs].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median across repeats for every numeric leaf, so one unlucky round can't move a verdict. */
function reduceRuns(runs) {
  const out = {};
  for (const k of Object.keys(runs[0])) {
    if (k === 'proc') continue;
    out[k] = median(runs.map((r) => r[k]));
  }
  if (runs[0].proc) {
    out.proc = {};
    for (const k of Object.keys(runs[0].proc)) out.proc[k] = median(runs.map((r) => r.proc[k]));
  }
  return out;
}

const COLUMNS = [
  ['variant', (r) => r.label, 14, (s) => s],
  ['cpu%', (r) => r.proc?.totalCpuPct, 7, (v) => v.toFixed(1)],
  ['rend%', (r) => r.proc?.rendererCpuPct, 7, (v) => v.toFixed(1)],
  ['gpu%', (r) => r.proc?.gpuCpuPct, 7, (v) => v.toFixed(1)],
  ['main%', (r) => r.mainThreadPct, 7, (v) => v.toFixed(1)],
  ['script%', (r) => r.scriptPct, 8, (v) => v.toFixed(1)],
  ['style%', (r) => r.stylePct, 7, (v) => v.toFixed(1)],
  ['layout%', (r) => r.layoutPct, 8, (v) => v.toFixed(1)],
  ['ms/fr', (r) => r.cpuMsFrame, 7, (v) => v.toFixed(1)],
  ['main/fr', (r) => r.mainMsFrame, 8, (v) => v.toFixed(1)],
  ['fps', (r) => r.fps, 6, (v) => v.toFixed(1)],
  ['p95ms', (r) => r.p95Ms, 7, (v) => v.toFixed(1)],
  ['jank%', (r) => r.jankPct, 7, (v) => v.toFixed(1)],
  ['heapMB', (r) => r.heapMB, 8, (v) => v.toFixed(1)],
  ['rssMB', (r) => r.proc && (r.proc.rendererRssMB + r.proc.gpuRssMB + r.proc.browserRssMB), 7, (v) => v.toFixed(0)],
  ['layers', (r) => r.layerCount, 7, (v) => v.toFixed(0)],
  ['layerMB', (r) => r.layerMemMB, 8, (v) => v.toFixed(0)],
];

function table(results) {
  const head = COLUMNS.map(([n, , w]) => n.padEnd(w)).join('');
  const lines = [head, '-'.repeat(head.length)];
  for (const r of results) {
    lines.push(COLUMNS.map(([, get, w, fmt]) => {
      const v = get(r);
      const s = v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '-' : (typeof v === 'number' ? fmt(v) : v);
      return String(s).padEnd(w);
    }).join(''));
  }
  return lines.join('\n');
}

/** Deltas against the FIRST variant, which is the baseline by convention. */
function deltaTable(results) {
  if (results.length < 2) return '';
  const base = results[0];
  const rows = [`vs ${base.label}:`];
  for (const r of results.slice(1)) {
    const d = (get) => {
      const a = get(base);
      const b = get(r);
      if (a == null || b == null || !a) return '   -  ';
      const p = ((b - a) / a) * 100;
      return `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;
    };
    rows.push(
      // Per-frame first: it is the comparison that survives a frame-rate difference between variants.
      `  ${r.label.padEnd(14)} ms/fr ${d((x) => x.cpuMsFrame).padStart(6)}   ` +
      `main/fr ${d((x) => x.mainMsFrame).padStart(6)}   ` +
      `layerMB ${d((x) => x.layerMemMB).padStart(6)}   ` +
      `fps ${d((x) => x.fps).padStart(6)}`,
    );
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  const variants = opts.variants.map(splitVariant);

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Keep a backgrounded/occluded headless page on the same code path as a foreground one, or the
      // idle scenario would measure Chromium's throttling instead of the app. Withheld for `hidden`,
      // whose entire question is whether throttling reclaims the cost — these flags would suppress
      // the very behaviour it exists to observe.
      ...(opts.scenario === 'hidden' ? [] : [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ]),
      // One shared renderer would let one variant's leftover state follow the next one.
      '--site-per-process',
    ],
  });

  const runs = new Map(variants.map((v) => [v.label, []]));
  try {
    // Round-robin rather than all-repeats-of-a-variant: the machine warms, the regtest chain grows,
    // and blocks land at random. Interleaving spreads that drift evenly instead of donating it to
    // whichever variant happened to run last.
    for (let round = 0; round < opts.repeat; round++) {
      for (const v of variants) {
        const url = urlFor(opts.base, v.suffix);
        process.stderr.write(`  round ${round + 1}/${opts.repeat}  ${v.label.padEnd(14)} ${url}\n`);
        runs.get(v.label).push(await measure(browser, url, opts, opts.css.get(v.label), opts.js.get(v.label)));
      }
    }
  } finally {
    await browser.close();
  }

  const results = variants.map((v) => ({
    label: v.label,
    suffix: v.suffix,
    css: opts.css.get(v.label) ?? null, // recorded so a saved run says exactly what it measured
    js: opts.js.get(v.label) ?? null,
    ...reduceRuns(runs.get(v.label)),
  }));

  const report = {
    base: opts.base,
    scenario: opts.scenario,
    seconds: opts.seconds,
    repeat: opts.repeat,
    viewport: `${opts.width}x${opts.height}@${opts.dpr}`,
    reducedMotion: opts.reducedMotion,
    at: new Date().toISOString(),
    results,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      `\n${opts.scenario} · ${opts.seconds}s × ${opts.repeat} · ${opts.width}x${opts.height} · ${opts.base}\n` +
      `(headless: gpu%% is SOFTWARE raster — a relative index of compositor work, not a real client's load)\n\n` +
      table(results) + '\n\n' + deltaTable(results) + '\n',
    );
  }
  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
    process.stderr.write(`\nwrote ${opts.out}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  process.exit(1);
});
