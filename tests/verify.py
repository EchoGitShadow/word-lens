#!/usr/bin/env python3
"""Headless verification of Word Lens: orientation, box alignment, and common-word filter."""

from __future__ import annotations

import argparse
import base64
import json
import math
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "tests"
ARTIFACTS = ROOT / "tests" / "artifacts"
INTERESTING = {"serendipity", "remarkable", "lucid"}
COMMON_SHOULD_HIDE = {"the", "of", "is", "a", "each", "word", "language", "understand"}


def rotate_point_ccw(x: float, y: float, src_w: float, src_h: float, angle_ccw_deg: float, new_w: float, new_h: float) -> tuple[float, float]:
    """Map a point from an image to a PIL-style expanded rotation (CCW, Y-down, centered)."""
    th = math.radians(angle_ccw_deg)
    dx = x - src_w / 2
    dy = y - src_h / 2
    c, s = math.cos(th), math.sin(th)
    rx = dx * c + dy * s
    ry = -dx * s + dy * c
    return rx + new_w / 2, ry + new_h / 2


def rotate_90_ccw(x: float, y: float, src_w: float, src_h: float) -> tuple[float, float]:
    # size becomes (src_h, src_w)
    return y, src_w - 1 - x


def rotate_180(x: float, y: float, src_w: float, src_h: float) -> tuple[float, float]:
    return src_w - 1 - x, src_h - 1 - y


def load_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def expected_center(ref: dict, name: str, src_w: int, src_h: int, new_w: int, new_h: int) -> tuple[float, float]:
    x, y = ref[name]["cx"], ref[name]["cy"]
    if name_angle := None:
        pass
    return x, y


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Base URL of the app")
    parser.add_argument("--out", default=str(ARTIFACTS), help="Artifact directory")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {"url": args.url, "ok": False, "checks": []}

    def check(name: str, passed: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "passed": bool(passed), "detail": detail})
        mark = "PASS" if passed else "FAIL"
        print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""), flush=True)

    samples = {
        "0": {"path": SAMPLES / "sample-text.png", "angle": 0},
        "90": {"path": SAMPLES / "sample-text-90.png", "angle": 90},
        "180": {"path": SAMPLES / "sample-text-180.png", "angle": 180},
        "20": {"path": SAMPLES / "sample-text-20.png", "angle": -20},
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                "Mobile/15E148 Safari/604.1"
            ),
        )
        page = context.new_page()
        page.set_default_timeout(30000)

        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#open-camera", timeout=15000)
        title = page.title()
        check("page_loads", title == "Word Lens", f"title={title!r}")

        has_manifest = page.locator('link[rel="manifest"]').count() == 1
        apple_capable = page.locator('meta[name="apple-mobile-web-app-capable"]').count() == 1
        apple_icon = page.locator('link[rel="apple-touch-icon"]').count() == 1
        check("pwa_meta", has_manifest and apple_capable and apple_icon)

        sw = page.evaluate(
            """async () => {
              if (!('serviceWorker' in navigator)) return { supported: false };
              const reg = await navigator.serviceWorker.ready;
              return { supported: true, scriptURL: reg.active && reg.active.scriptURL };
            }"""
        )
        check("service_worker", bool(sw.get("supported") and sw.get("scriptURL")), json.dumps(sw))

        is_https = args.url.startswith("https://")
        is_local = args.url.startswith("http://127.0.0.1") or args.url.startswith("http://localhost")
        check("secure_context_url", is_https or is_local, args.url)
        if is_https:
            check("https", True, args.url)

        cache_name = page.evaluate(
            """async () => {
              const names = await caches.keys();
              return names;
            }"""
        )
        check("sw_cache_v2", any("word-lens-v2" in n for n in cache_name), json.dumps(cache_name))

        page.screenshot(path=str(out / "start.png"), full_page=True)

        # Default to filtered mode for these checks.
        page.evaluate("() => window.__wordLensTest.setShowAll(false)")

        def run_ocr(label: str, path: Path):
            b64 = load_b64(path)
            page.set_default_timeout(180000)
            try:
                words = page.evaluate(
                    """async (b64) => {
                      const binary = atob(b64);
                      const bytes = new Uint8Array(binary.length);
                      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                      const blob = new Blob([bytes], { type: 'image/png' });
                      await window.__wordLensTest.setShowAll(false);
                      await window.__wordLensTest.recognizeImageBlob(blob);
                      return window.__wordLensTest.getState();
                    }""",
                    b64,
                )
            except Exception as exc:
                page.screenshot(path=str(out / f"ocr-error-{label}.png"), full_page=True)
                check(f"ocr_{label}_completes", False, str(exc))
                page.set_default_timeout(30000)
                return None
            page.set_default_timeout(30000)
            check(
                f"ocr_{label}_completes",
                isinstance(words, dict) and len(words.get("words") or []) > 0,
                f"count={len((words or {}).get('words') or [])} angle={((words or {}).get('orientation') or {}).get('angle')}",
            )
            page.screenshot(path=str(out / f"ocr-{label}.png"), full_page=True)
            return words

        states = {}
        for label, meta in samples.items():
            states[label] = run_ocr(label, meta["path"])

        upright = states.get("0") or {}
        ref_words = {w["word"]: w for w in upright.get("words") or []}
        src_w = (upright.get("frame") or {}).get("width") or 1600
        src_h = (upright.get("frame") or {}).get("height") or 1000

        for label in ("0", "90", "180", "20"):
            state = states.get(label) or {}
            found = {w["word"] for w in state.get("words") or []}
            visible = set(state.get("visible") or [])
            missing_interesting = sorted(INTERESTING - visible)
            leaked_common = sorted((COMMON_SHOULD_HIDE & visible))
            check(
                f"filter_{label}_keeps_interesting",
                not missing_interesting,
                f"visible={sorted(visible)} missing={missing_interesting}",
            )
            check(
                f"filter_{label}_hides_common",
                not leaked_common,
                f"leaked={leaked_common} found_all={sorted(found)}",
            )

            # Alignment: map 0° centers into this image and compare.
            if label == "0" or not ref_words or not state.get("words"):
                if label == "0" and ref_words:
                    # Self-alignment: boxes should sit on the words; just check they have size.
                    ok = all(ref_words[w]["width"] > 20 and ref_words[w]["height"] > 8 for w in INTERESTING if w in ref_words)
                    check("align_0_boxes_have_size", ok)
                continue

            frame = state.get("frame") or {}
            new_w = frame.get("width") or 0
            new_h = frame.get("height") or 0
            current = {w["word"]: w for w in state.get("words") or []}
            errors = []
            for word in INTERESTING:
                if word not in ref_words or word not in current:
                    errors.append(f"{word} missing")
                    continue
                rx, ry = ref_words[word]["cx"], ref_words[word]["cy"]
                if label == "90":
                    ex, ey = rotate_90_ccw(rx, ry, src_w, src_h)
                elif label == "180":
                    ex, ey = rotate_180(rx, ry, src_w, src_h)
                else:
                    ex, ey = rotate_point_ccw(rx, ry, src_w, src_h, 90 if False else -20, new_w, new_h)
                cx, cy = current[word]["cx"], current[word]["cy"]
                dist = math.hypot(cx - ex, cy - ey)
                # Allow a generous fraction of the word size; 20° interpolation is looser.
                tol = max(36, 0.45 * max(ref_words[word]["width"], current[word]["width"]))
                if dist > tol:
                    errors.append(f"{word} dist={dist:.1f}px tol={tol:.1f} got=({cx:.1f},{cy:.1f}) expected=({ex:.1f},{ey:.1f})")
            check(f"align_{label}_boxes", not errors, "; ".join(errors) or "ok")

        # Toggle should reveal common words on the upright photo.
        if states.get("0"):
            page.evaluate("() => window.__wordLensTest.setShowAll(true)")
            shown = page.evaluate("() => window.__wordLensTest.getState()")
            visible = set(shown.get("visible") or [])
            revealed = sorted(COMMON_SHOULD_HIDE & visible)
            check(
                "toggle_show_all_reveals_common",
                len(revealed) >= 4,
                f"revealed={revealed} visible={sorted(visible)}",
            )
            page.screenshot(path=str(out / "ocr-0-show-all.png"), full_page=True)
            page.evaluate("() => window.__wordLensTest.setShowAll(false)")
            hidden_again = set(page.evaluate("() => window.__wordLensTest.getState()").get("visible") or [])
            leaked = sorted(COMMON_SHOULD_HIDE & hidden_again)
            check("toggle_hide_common_again", not leaked, f"leaked={leaked}")

            # Definition still works for an interesting word.
            page.evaluate("() => window.__wordLensTest.openWord('serendipity')")
            page.wait_for_selector("#sheet:not([hidden])", timeout=10000)
            page.wait_for_function(
                """() => {
                  const body = document.getElementById('sheet-body');
                  return body && !body.querySelector('.pending');
                }""",
                timeout=30000,
            )
            body_text = page.inner_text("#sheet-body")
            word_text = page.inner_text("#sheet-word")
            ok_def = "serendipity" in word_text.lower() and (
                "fortunate" in body_text.lower() or "luck" in body_text.lower() or "discovery" in body_text.lower()
            )
            check("definition_lookup", ok_def, f"word={word_text!r} body={body_text[:200]!r}")
            page.screenshot(path=str(out / "definition.png"), full_page=True)

        browser.close()

    required = report["checks"] if args.url.startswith("https://") else [c for c in report["checks"] if c["name"] != "https"]
    report["ok"] = all(c["passed"] for c in required)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"ok": report["ok"], "url": args.url, "artifact_dir": str(out)}, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
