#!/usr/bin/env python3
"""Before/after OCR and lookup quality checks for Word Lens."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HARD = ROOT / "tests" / "hard"
INTERESTING = ["serendipity", "remarkable", "lucid"]
BOOK_EXTRA = ["running", "studies", "wolves", "curiosity", "discovery"]
LOOKUP_WORDS = ["running", "studies", "wolves", "happily", "remarkable.", "wolves'", "running"]


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

    images = [
        ("clean", HARD / "clean.png", INTERESTING),
        ("blur", HARD / "blur.png", INTERESTING),
        ("low-light", HARD / "low-light.png", INTERESTING),
        ("glare", HARD / "glare.png", INTERESTING),
        ("small-text", HARD / "small-text.png", INTERESTING),
        ("tilted", HARD / "tilted.png", INTERESTING),
        ("warm-2700k", HARD / "warm-2700k.png", INTERESTING),
        ("cool-tint", HARD / "cool-tint.png", INTERESTING),
        ("dim-warm", HARD / "dim-warm.png", INTERESTING),
        ("book-page", HARD / "book-page.png", INTERESTING + BOOK_EXTRA),
        ("book-warm-2700k", HARD / "book-warm-2700k.png", INTERESTING + BOOK_EXTRA),
    ]

    report = {"label": args.label, "url": args.url, "images": [], "lookups": [], "ok": False}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page = context.new_page()
        page.set_default_timeout(180000)
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#open-camera", timeout=15000)

        for name, path, expected in images:
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
            found = sorted({w["word"] for w in (state.get("words") or [])})
            hits = [w for w in expected if w in found]
            rec = {
                "name": name,
                "ok": len(hits) >= min(3, len(expected)),
                "found_count": len(found),
                "found": found,
                "hits": hits,
                "misses": [w for w in expected if w not in found],
                "expected": expected,
                "orientation": (state.get("orientation") or {}).get("angle"),
            }
            report["images"].append(rec)
            page.screenshot(path=str(out / f"{name}.png"), full_page=True)
            mark = "PASS" if rec["ok"] else "WEAK"
            print(f"[{mark}] {name} hits={hits} misses={rec['misses']} count={len(found)} angle={rec['orientation']}", flush=True)

        # Lookups (inflections and messy tokens)
        for word in ["running", "studies", "wolves", "happily", "remarkable.", "wolves'", "Studies"]:
            try:
                result = page.evaluate(
                    """async (word) => {
                      const fn = window.__wordLensTest.lookup;
                      const data = await fn(word);
                      const first = Array.isArray(data) ? data[0] : data;
                      const meanings = (first && first.meanings) || [];
                      const def = ((((meanings[0] || {}).definitions || [])[0] || {}).definition) || "";
                      return {
                        word: (first && first.word) || word,
                        pos: (meanings[0] || {}).partOfSpeech || "",
                        definition: def.slice(0, 180),
                        queried: first && first._queried,
                        source: first && first._source,
                      };
                    }""",
                    word,
                )
                ok = bool(result and result.get("definition"))
            except Exception as exc:
                result, ok = {"error": str(exc)}, False
            report["lookups"].append({"query": word, "ok": ok, "result": result})
            print(f"[{'PASS' if ok else 'FAIL'}] lookup {word!r} -> {result}", flush=True)

        browser.close()

    detected = sum(1 for r in report["images"] if r.get("ok"))
    total = len([r for r in report["images"] if "ok" in r])
    lookups_ok = sum(1 for r in report["lookups"] if r.get("ok"))
    report["detection_rate"] = f"{detected}/{total}"
    report["lookup_rate"] = f"{lookups_ok}/{len(report['lookups'])}"
    report["ok"] = detected == total and lookups_ok == len(report["lookups"])
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"label": args.label, "detection": report["detection_rate"], "lookups": report["lookup_rate"], "ok": report["ok"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
