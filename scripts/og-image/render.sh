#!/usr/bin/env bash
# Render the Open Graph card (frontend/public/og-image.png) from og.html.
#
# og.html is a standalone 1200×630 poster that re-uses the app's own artwork: the crest from
# frontend/public/logo.svg, the isometric cube geometry + 'emerald-steel' colorway from
# frontend/src/iso.ts, the seven-segment digits from SegmentClock.tsx, and the die-cut violation /
# BIP-110 stickers from ViolationStickers.tsx. If any of those change, re-run this.
#
# There is no node on the host — everything runs in the puppeteer image (see the project memory).
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)

docker run --rm \
  -v "$PWD":/usr/src/app/og \
  -v "$ROOT/frontend/public":/pub \
  -w /usr/src/app \
  zenika/alpine-chrome:with-puppeteer \
  node og/shoot.js /usr/src/app/og/og.html /pub/og-image.png 1200 630

python3 optimize.py "$ROOT/frontend/public/og-image.png"

echo "wrote $ROOT/frontend/public/og-image.png"
