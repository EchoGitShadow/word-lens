#!/usr/bin/env python3
"""Build close-up test photos from the existing hard-page samples."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
HARD = ROOT / "tests" / "hard"


def page_bg(im: Image.Image) -> tuple[int, int, int]:
    arr = np.array(im.convert("RGB"))
    corners = np.concatenate(
        [
            arr[:20, :20].reshape(-1, 3),
            arr[:20, -20:].reshape(-1, 3),
            arr[-20:, :20].reshape(-1, 3),
            arr[-20:, -20:].reshape(-1, 3),
        ]
    )
    return tuple(int(x) for x in np.median(corners, axis=0))


def contain_to(crop: Image.Image, size: tuple[int, int], bg: tuple[int, int, int]) -> Image.Image:
    tw, th = size
    scale = min(tw / crop.width, th / crop.height)
    nw, nh = int(round(crop.width * scale)), int(round(crop.height * scale))
    resized = crop.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, bg)
    canvas.paste(resized, ((tw - nw) // 2, (th - nh) // 2))
    return canvas


def save_pair(image: Image.Image, name: str, radius: float) -> None:
    HARD.mkdir(parents=True, exist_ok=True)
    image.save(HARD / f"{name}.png", optimize=True)
    image.filter(ImageFilter.GaussianBlur(radius=radius)).save(HARD / f"{name}-blur.png", optimize=True)
    print(f"wrote {name} {image.size}")


def main() -> int:
    clean = Image.open(HARD / "clean.png")
    bg = page_bg(clean)
    # 3 lines, fully visible: serendipity, language, lucid, definition, helps, understand, each
    closeup = contain_to(clean.crop((230, 200, 1020, 545)), (1920, 1080), bg)
    save_pair(closeup, "close-up", 1.45)
    # Tighter crop so a few words fill the frame
    tight = contain_to(clean.crop((230, 220, 675, 530)), (1600, 1200), bg)
    save_pair(tight, "close-up-tight", 1.4)

    book = Image.open(HARD / "book-page.png")
    # 3 body lines of the book page filling a portrait frame
    book_close = contain_to(book.crop((761, 340, 1037, 600)), (1800, 2400), page_bg(book))
    save_pair(book_close, "close-up-book", 1.35)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
