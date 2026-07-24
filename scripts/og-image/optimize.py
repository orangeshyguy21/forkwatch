#!/usr/bin/env python3
"""Shrink the rendered card in place, losslessly enough for a social preview.

Chromium writes a 32-bit RGBA PNG (~360 KB). The card has no transparency and only a few hundred
distinct colours, so dropping the alpha channel and quantizing to a 256-colour palette with
libimagequant takes it to ~110 KB with no visible change — libimagequant's error diffusion holds the
smooth glows and gradients that a plain median-cut palette visibly speckles.

Size matters here beyond page weight: WhatsApp only renders the *large* link preview when the
og:image is under ~300 KB, and falls back to a thumbnail above it.

Falls back to a plain RGB re-save if Pillow was built without libimagequant.
"""

import sys
from pathlib import Path

from PIL import Image, features

path = Path(sys.argv[1])
before = path.stat().st_size

im = Image.open(path).convert("RGB")
if features.check("libimagequant"):
    im = im.quantize(colors=256, method=Image.LIBIMAGEQUANT)
im.save(path, optimize=True)

after = path.stat().st_size
print(f"optimized {path.name}: {before // 1024} KB -> {after // 1024} KB")
