# Client-resource profiler

Measures what a Forkwatch page costs the machine it is open on, and lets you A/B a change against
that number. Built because the app was suspected of spiking client resources with nothing happening
on screen — it is, and this is how that was established.

Nothing here needs node on the host: everything runs in the `zenika/alpine-chrome:with-puppeteer`
image against an app already served by docker-compose (regtest on `:8080`, mainnet on `:8081`).

```
./bench.sh                                        # idle, backdrop variants, regtest
./bench.sh scroll --base http://127.0.0.1:8081    # flying the chain, mainnet
./bench.sh idle --repeat 5 --seconds 15           # longer / more repeats
```

## What it reports

Per variant, median across repeats:

| column | what it is |
| --- | --- |
| `cpu%` / `rend%` / `gpu%` | CPU as % of one core, per chromium process class, from `/proc` |
| `main%` `script%` `style%` `layout%` | renderer main thread, split by `Performance.getMetrics` |
| `ms/fr`, `main/fr` | **CPU per frame delivered** — the comparison to use |
| `fps` `p95ms` `jank%` | frame delivery, from an in-page rAF probe |
| `layers` `layerMB` | composited layer census, from CDP `LayerTree` |
| `heapMB` `rssMB` | JS heap; resident memory across all chromium processes |

Three cost centres are kept separate on purpose, because they are fixed in completely different ways:
main-thread CPU is React/style/layout, gpu-process CPU is compositing and raster, and frame health is
what the user actually feels. A change that halves `script%` but leaves `gpu%` flat did nothing for a
client whose cost is compositing.

### Read `ms/fr`, not `cpu%`, when frame rates differ

Per-second CPU is confounded by throughput, in the direction that flatters the slow variant: a page
too slow to reach 60fps renders fewer frames and so posts a *lower* `cpu%` while feeling worse. On
the scroll scenario, switching the backdrop off doubled the frame rate and thereby raised `cpu%` by
45% — which reads as a regression and is the opposite of what happened. `ms/fr` divides by frames
actually delivered and removes the confound.

### The frame probe is also a frame *requester* — use `--no-probe` for idle questions

The rAF probe that produces `fps`/`jank%` obliges the browser to produce frames continuously. That is
harmless on a page which was going to do that anyway, but it completely masks a page that has learned
to go quiet: the parking fix measured 27% CPU with the probe on and 7% with `--no-probe`. Whenever
the question is "does this page idle?", pass `--no-probe` — it trades the frame columns for an honest
CPU number. Use the probe when comparing pages that are both busy (e.g. the `scroll` scenario).

### Two limits worth knowing

**`gpu%` is software raster.** Headless Chromium has no GPU here (no nvidia-container-toolkit
installed), so it rasterizes through SwiftShader on the CPU. That makes compositing *visible* as a
number, which is useful, but it saturates: once the compositor is pinned at ~100% of a core, a
heavier variant and a much heavier variant both read "100%" and `fps` becomes the only thing still
discriminating. Never quote `gpu%` as a real client's load. If hardware raster is ever needed, it
means installing the matching NVIDIA userspace driver into the image.

**`layerMB` is not.** Layer count and area come from the same compositing decisions on every device.
They set GPU memory (area × 4 bytes, held for as long as the page is open) and the per-frame fill the
compositor must do. This is the compositor metric that transfers off this machine — prefer it when
quoting a result. (`layers` is a point-in-time snapshot and jitters with transient animations;
`layerMB` is stable.)

## What it found (2026-07-25, mainnet `:8081`, 1440×900, idle)

| | full | `?bg=off` |
| --- | --- | --- |
| fps | 26.4 | 56.8 |
| jank% | 98.5 | 5.7 |
| gpu cpu% | ~100 (saturated) | 19 |
| layer MB | 59 | 13 |
| rss MB | 679 | 550 |

...with the page untouched. And under `quiesce`, the **full** backdrop costs 6% total CPU — so the
layers cost essentially nothing at rest. The cost is entirely per-frame recompositing, and the page
never stops requesting frames: two unconditional rAF loops (`useScrollFocus`, `Backdrop`) plus an
infinite CSS animation (`.fw-bd-breathe`) keep it awake at 60fps forever, even parked at the tip.

**Where the per-composite cost sits.** Measured under a 10fps tick, which unsaturates the compositor
and makes `ms/fr` directly readable as the cost of one composite:

| | planes | layer MB | ms per composite |
| --- | --- | --- | --- |
| `full` | 5 | 57 | 58.8 |
| `?bg=field` | 3 | 44 | 54.8 |
| `?bg=lattice` | 2 | 33 | 27.0 |
| `?bg=off` | 0 | 13 | 21.5 |

The mote field is ~33ms of the backdrop's ~37ms — roughly six times the lattice's cost, and it is
also the only part with a nonzero `drift`, i.e. the only reason the page can never park. Its planes
carry a 300px tile period, so `overhangFor` makes each one 1516px tall for a 900px viewport.

Throttling is a weak lever on its own: at 10fps the backdrop still costs 55% of a core, and even at
4fps it costs 40%, because cost is (frames × cost-per-composite) and the second factor is large.
Stopping entirely is worth ~16× (100% → 6%); slowing down is worth ~2×.

### Outcome

Parking the loops (one shared rAF that stops at rest; mote `drift` and the bloom breathe removed)
took idle from **107% → 25%** of a core. Scroll was unchanged, as expected — everything is
legitimately moving there.

The remaining 25% turned out not to be the backdrop at all: it is the countdown's 7-segment clock.
Each tick flips segments between `opacity-100` and `opacity-[0.07]` through a 150ms CSS transition
(`SegmentClock.tsx:97`), so the page composites for ~150ms out of every second, forever. Disabling
just that transition takes idle to **5%**. It is a *transition*, not an animation, and it is
compositor-driven — so it never appears as an rAF callback and `getAnimations()` only catches it in
about half of samples. Worth remembering: `*{animation:none}` does not cover it; you need
`transition:none` too.

Note what it is *not*: killing the masks, `will-change`, the grain blend mode, or the breathe
animation individually each moved the compositor number by ~0 (dropping `will-change` made it worse,
+44%, by moving raster onto the renderer). `?bg=lattice` has `drift: 0` and writes zero transforms at
a parked tip, yet still pins the compositor — so it is not the movement, it is the per-frame
compositing of full-viewport layers.

## Variants

A variant is a label plus a URL suffix, so the app's own debug params are the benchmark axes:

```
--variant 'full:'  --variant 'bg-off:?bg=off'  --variant 'far:?zoom=3'
```

- `?bg=off|lattice|field|both` — backdrop pieces (see `Backdrop.tsx`)
- `?zoom=0..4` — camera detent, which decides how many blocks are on screen
- `?focus=<h>` — park at a height instead of the tip

`--css 'label=<rules>'` injects a stylesheet into one variant and `--js 'label=<code>'` runs code
(after settle, so it lands on steady state), so a candidate fix can be measured *before* it is
written:

```
--variant 'no-breathe:' --css 'no-breathe=.fw-bd-breathe{animation:none!important}'
--variant 'slow-tick:'  --js  'slow-tick=window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),100)'
```

The second one is how the throttling numbers above were obtained without touching the app.

## Scenarios

- `idle` — untouched. The case that matters most: a wall display left open. Anything burning CPU
  here burns it forever.
- `scroll` — a sustained fly through history (wheel bursts, reversing before the ends). Exercises the
  per-frame React path, where every visible block re-renders.
- `quiesce` — the page is open but requests no frames at all (rAF neutered, CSS animations halted).
  The at-rest floor. **`idle` minus `quiesce` is the per-frame cost**, and that subtraction is the
  most diagnostic measurement here: a large gap means the page is paying to redraw something nobody
  asked it to redraw. Reports no frame metrics — it has no rAF probe, because the probe would itself
  force the frame production the scenario exists to remove.
- `hidden` — backgrounded tab. **Unreliable headless:** `setPageVisibilityOverride` does not actually
  throttle rAF here, so it reports the same numbers as `idle`. Use `quiesce` instead.

## Before/after a code change

```
./bench.sh idle --out-name before        # on master
# ...make the change, rebuild the frontend...
./bench.sh idle --out-name after
docker run --rm -v "$PWD":/w -w /w --entrypoint node node:20-slim compare.mjs out/before.json out/after.json
```

`compare.mjs` matches variants by label across the two runs and labels each metric better / WORSE /
flat, with fps handled as higher-is-better. Anything under 5% is called flat.

## Noise

Use `--repeat 3` or more; the runner interleaves variants round-robin rather than running all
repeats of one variant together, so machine warm-up and block arrivals spread evenly instead of
landing on whichever variant went last.

**Pick the right chain.** Regtest mines continuously, so a 10s idle window may or may not contain a
block spawn — that swung idle CPU between 3% and 35% on the same variant. Use mainnet (`:8081`) for a
quiet idle baseline, and regtest when you specifically want spawn animations in the measurement.
