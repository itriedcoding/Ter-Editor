#!/usr/bin/env python3
"""Draws the Ter Editor app icon and writes PNG/ICO/ICNS variants.

The mark is built from geometry (no font dependency) and rendered at 4096px
with a final Lanczos downsample so 16px icons stay crisp.
"""
from io import BytesIO
from pathlib import Path
from struct import pack

from PIL import Image, ImageDraw

S = 4096
OUT = Path(__file__).resolve().parent.parent / "build"
OUT.mkdir(parents=True, exist_ok=True)
ICONS = OUT / "icons"
ICONS.mkdir(exist_ok=True)


def gradient(size: int) -> Image.Image:
    small = Image.new("RGB", (64, 64))
    pixels = small.load()
    top = (33, 45, 66)
    bottom = (10, 13, 20)
    for y in range(64):
        t = y / 63
        for x in range(64):
            sheen = 16 * min(1.0, max(0.0, (x / 63 - 0.25)))
            pixels[x, y] = (
                int(top[0] + (bottom[0] - top[0]) * t),
                int(top[1] + (bottom[1] - top[1]) * t),
                int(top[2] + (bottom[2] - top[2]) * t + sheen),
            )
    return small.resize((size, size), Image.BICUBIC)


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius), fill=255)
    return mask


icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(gradient(S), (0, 0), rounded_mask(S, 0.225))

edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle(
    [int(S * 0.012), int(S * 0.012), S - int(S * 0.012), S - int(S * 0.012)],
    radius=int(S * 0.215),
    outline=(126, 160, 214, 80),
    width=int(S * 0.011),
)
icon = Image.alpha_composite(icon, edge)

draw = ImageDraw.Draw(icon)
white = (242, 246, 255, 255)

# The T: a wide top bar and a stem, both with soft rounded ends.
draw.rounded_rectangle(
    [int(S * 0.285), int(S * 0.275), int(S * 0.615), int(S * 0.355)],
    radius=int(S * 0.022),
    fill=white,
)
draw.rounded_rectangle(
    [int(S * 0.412), int(S * 0.275), int(S * 0.488), int(S * 0.685)],
    radius=int(S * 0.021),
    fill=white,
)

# Cursor bar: the caret sitting after the letter.
caret = [int(S * 0.645), int(S * 0.44), int(S * 0.715), int(S * 0.685)]
draw.rounded_rectangle(caret, radius=int(S * 0.017), fill=(88, 166, 255, 255))

icon.resize((1024, 1024), Image.LANCZOS).save(OUT / "icon.png")
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    icon.resize((size, size), Image.LANCZOS).save(ICONS / f"{size}x{size}.png")
icon.resize((256, 256), Image.LANCZOS).save(
    OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
)


def icns_entry(kind: bytes, image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    payload = buffer.getvalue()
    return kind + pack(">I", len(payload) + 8) + payload


entries = [
    icns_entry(b"icp4", icon.resize((16, 16), Image.LANCZOS)),
    icns_entry(b"icp5", icon.resize((32, 32), Image.LANCZOS)),
    icns_entry(b"icp6", icon.resize((64, 64), Image.LANCZOS)),
    icns_entry(b"ic07", icon.resize((128, 128), Image.LANCZOS)),
    icns_entry(b"ic08", icon.resize((256, 256), Image.LANCZOS)),
    icns_entry(b"ic09", icon.resize((512, 512), Image.LANCZOS)),
    icns_entry(b"ic10", icon.resize((1024, 1024), Image.LANCZOS)),
    icns_entry(b"ic11", icon.resize((32, 32), Image.LANCZOS)),
    icns_entry(b"ic12", icon.resize((64, 64), Image.LANCZOS)),
    icns_entry(b"ic13", icon.resize((256, 256), Image.LANCZOS)),
    icns_entry(b"ic14", icon.resize((512, 512), Image.LANCZOS)),
]
body = b"".join(entries)
(OUT / "icon.icns").write_bytes(b"icns" + pack(">I", len(body) + 8) + body)
print("wrote build/icon.png, build/icon.ico, build/icon.icns and build/icons/")
