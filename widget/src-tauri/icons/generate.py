#!/usr/bin/env python3
"""Generate the widget's app icons.

Regenerate with `python3 icons/generate.py` after changing the mark. Kept as a
script rather than committed binaries alone so the icon stays editable.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent
BG = (10, 10, 12, 255)
RING = (255, 75, 18, 255)
BAR = (111, 98, 216, 255)

# Drawn oversized and downsampled; the ring is thin enough to alias badly at
# 32px if rendered directly at that size.
S = 1024


def render() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad, radius = S * 0.06, S * 0.22
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=BG)

    # The status ring, echoing the widget's CLAUDE mark.
    cx, cy, r, w = S * 0.5, S * 0.40, S * 0.20, S * 0.055
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=int(w))

    # A meter beneath it, part filled, matching the widget's bar.
    bar_h = S * 0.075
    x0, x1, y0 = S * 0.22, S * 0.78, S * 0.70
    d.rounded_rectangle([x0, y0, x1, y0 + bar_h], radius=bar_h / 2, fill=BAR)
    d.rounded_rectangle(
        [x0, y0, x0 + (x1 - x0) * 0.42, y0 + bar_h], radius=bar_h / 2, fill=RING
    )
    return img


def main() -> None:
    master = render()
    master.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    for size in (32, 128, 256):
        name = "128x128@2x.png" if size == 256 else f"{size}x{size}.png"
        master.resize((size, size), Image.LANCZOS).save(OUT / name)

    master.resize((256, 256), Image.LANCZOS).save(
        OUT / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)]
    )
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
