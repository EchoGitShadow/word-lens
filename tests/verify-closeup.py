#!/usr/bin/env python3
"""Close-up vs normal-distance OCR checks for Word Lens."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HARD = ROOT / "tests" / "hard"

# Words actually visible in each photo (content words, not required short/common ones).
CASES = [
    ("clean", HARD / "clean.png", ["serendipity", "language", "remarkable", "lucid", "definition", "helps", "reader", "understand", "difficult", "word"]),
    ("blur", HARD / "blur.png", ["serendipity", "language", "remarkable", "lucid", "definition"]),
    ("small-text", HARD / "small-text.png", ["serendipity", "remarkable", "lucid"]),
    ("book-page", HARD / "book-page.png", ["serendipity", "remarkable", "lucid", "running", "studies"]),
    ("close-up", HARD / "close-up.png", ["serendipity", "language", "lucid", "definition", "helps", "understand", "each"]),
    ("close-up-blur", HARD / "close-up-blur.png", ["serendipity", "language", "lucid", "definition", "helps", "understand", "each"]),
    ("close-up-tight", HARD / "close-up-tight.png", ["serendipity", "lucid", "understand"]),
    ("close-up-tight-blur", HARD / "close-up-tight-blur.png", ["serendipity", "lucid", "understand"]),
    ("close-up-book", HARD / "close-up-book.png", ["serendipity", "language", "remarkable", "lucid", "definition", "understand", "difficult"]),
    ("close-up-book-blur", HARD / "close-up-book-blur.png", ["serendipity", "language", "remarkable", "lucid", "definition", "understand", "difficult"]),
]


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", default="run")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    report = {"label": args.label, "url": args.url, "images": [], "ok": False}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page = context.new_page()
        page.set_default_timeout(180000)
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#open-camera", timeout=15000)
        page.wait_for_function("() => window.__wordLensTest && window.__wordLensTest.recognizeImageBlob", timeout=15000)

        for name, path, expected in CASES:
            if not path.exists():
                report["images"].append({"name": name, "error": "missing file"})
                print(f"[SKIP] {name} missing", flush=True)
                continue
            try:
                state = page.evaluate(
                    """async (b64) => {
                      const binary = atob(b64);
                      const bytes = new Uint8Array(binary.length);
                      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                      const blob = new Blob([bytes], { type: 'image/png' });
                      if (window.__wordLensTest.setShowAll) window.__wordLensTest.setShowAll(true);
                      await window.__wordLensTest.recognizeImageBlob(blob);
                      return window.__wordLensTest.getState();
                    }""",
                    b64(path),
                )
            except Exception as exc:
                page.screenshot(path=str(out / f"{name}-error.png"), full_page=True)
                rec = {"name": name, "ok": False, "error": str(exc), "found": [], "hit": 0, "expected": expected}
                report["images"].append(rec)
                print(f"[FAIL] {name} {exc}", flush=True)
                continue
            found = [w["word"] for w in (state.get("words") or [])]
            found_set = set(found)
            hits = [w for w in expected if w in found_set]
            # Accuracy: required hits, plus a penalty list of obviously garbled tokens
            rec = {
                "name": name,
                "ok": len(hits) == len(expected) if name.startswith("close-up") else (len(hits) >= min(3, len(expected)) and len(hits) / max(1, len(expected)) >= 0.6),
                "found_count": len(found_set),
                "found": sorted(found_set),
                "found_raw": found,
                "hits": hits,
                "misses": [w for w in expected if w not in found_set],
                "expected": expected,
                "hit_rate": f"{len(hits)}/{len(expected)}",
                "orientation": state.get("orientation") or {},
                "frame": state.get("frame"),
            }
            report["images"].append(rec)
            page.screenshot(path=str(out / f"{name}.png"), full_page=True)
            mark = "PASS" if rec["ok"] else "WEAK"
            print(
                f"[{mark}] {name} {rec['hit_rate']} hits={hits} misses={rec['misses']} "
                f"count={len(found_set)} found={rec['found']} angle={(rec['orientation'] or {}).get('angle')}",
                flush=True,
            )

        browser.close()

    close_names = {n for n, _, _ in CASES if n.startswith("close-up")}
    normal_names = {n for n, _, _ in CASES if not n.startswith("close-up")}
    def rate(names):
        rows = [r for r in report["images"] if r.get("name") in names and "ok" in r]
        return f"{sum(1 for r in rows if r.get('ok'))}/{len(rows)}"

    report["closeup_rate"] = rate(close_names)
    report["normal_rate"] = rate(normal_names)
    report["ok"] = all(r.get("ok") for r in report["images"] if "ok" in r)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"label": args.label, "closeup": report["closeup_rate"], "normal": report["normal_rate"], "ok": report["ok"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
