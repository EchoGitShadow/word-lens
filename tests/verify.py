#!/usr/bin/env python3
"""Headless verification of Word Lens: page load, OCR, and dictionary lookup."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "tests" / "sample-text.png"
ARTIFACTS = ROOT / "tests" / "artifacts"
EXPECTED_WORDS = {"serendipity", "language", "remarkable", "lucid", "definition", "reader", "difficult"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Base URL of the app")
    parser.add_argument("--out", default=str(ARTIFACTS), help="Artifact directory")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {"url": args.url, "ok": False, "checks": []}

    def check(name: str, passed: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "passed": bool(passed), "detail": detail})
        mark = "PASS" if passed else "FAIL"
        print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))

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
        playsinline = page.locator("video#preview[playsinline]").count() == 1
        check("pwa_meta", has_manifest and apple_capable and apple_icon, f"manifest={has_manifest} capable={apple_capable} icon={apple_icon}")
        check("playsinline_video", playsinline)

        manifest = page.evaluate(
            """async () => {
              const href = document.querySelector('link[rel="manifest"]').href;
              const res = await fetch(href);
              const json = await res.json();
              return { status: res.status, json, href };
            }"""
        )
        check(
            "manifest_ok",
            manifest["status"] == 200
            and manifest["json"].get("display") == "standalone"
            and manifest["json"].get("short_name") == "Word Lens",
            json.dumps({"status": manifest["status"], "start_url": manifest["json"].get("start_url")}),
        )

        sw = page.evaluate(
            """async () => {
              if (!('serviceWorker' in navigator)) return { supported: false };
              const reg = await navigator.serviceWorker.ready;
              return { supported: true, scope: reg.scope, scriptURL: reg.active && reg.active.scriptURL };
            }"""
        )
        check("service_worker", bool(sw.get("supported") and sw.get("scriptURL")), json.dumps(sw))

        is_https = args.url.startswith("https://")
        is_local = args.url.startswith("http://127.0.0.1") or args.url.startswith("http://localhost")
        check("secure_context_url", is_https or is_local, args.url)
        if is_https:
            check("https", True, args.url)

        page.screenshot(path=str(out / "start.png"), full_page=True)

        image_bytes = SAMPLE.read_bytes()
        b64 = __import__("base64").b64encode(image_bytes).decode("ascii")
        page.set_default_timeout(180000)
        try:
            words = page.evaluate(
                """async (b64) => {
                  const binary = atob(b64);
                  const bytes = new Uint8Array(binary.length);
                  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                  const blob = new Blob([bytes], { type: 'image/png' });
                  return await window.__wordLensTest.recognizeImageBlob(blob);
                }""",
                b64,
            )
            check("ocr_completes", isinstance(words, list) and len(words) > 0, f"count={len(words) if words else 0}")
        except Exception as exc:
            page.screenshot(path=str(out / "ocr-error.png"), full_page=True)
            check("ocr_completes", False, str(exc))
            words = []
        page.set_default_timeout(30000)

        found = sorted({w["word"] for w in words}) if words else []
        missing = sorted(EXPECTED_WORDS - set(found))
        check("ocr_words", not missing, f"found={found} missing={missing}")
        box_count = page.locator(".word-box").count()
        check("word_boxes_drawn", box_count >= len(EXPECTED_WORDS) - 2, f"boxes={box_count}")
        page.screenshot(path=str(out / "ocr-boxes.png"), full_page=True)

        # Tap serendipity if present, else open via test hook.
        if any(w["word"] == "serendipity" for w in (words or [])):
            # Click the box whose aria-label mentions the word
            locator = page.locator('button.word-box[aria-label="Define serendipity"]')
            if locator.count():
                locator.last.click()
            else:
                page.evaluate("() => window.__wordLensTest.openWord('serendipity')")
        else:
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
        phonetic = page.inner_text("#sheet-phonetic")
        pos = page.locator("#sheet-body .pos").all_inner_texts()
        ok_def = "serendipity" in word_text.lower() and ("fortunate" in body_text.lower() or "luck" in body_text.lower() or "discovery" in body_text.lower())
        check(
            "definition_lookup",
            ok_def,
            f"word={word_text!r} phonetic={phonetic!r} pos={pos!r} body={body_text[:240]!r}",
        )
        page.screenshot(path=str(out / "definition.png"), full_page=True)

        # Unknown word
        page.evaluate("() => window.__wordLensTest.openWord('xyzzywordq')")
        page.wait_for_function(
            """() => {
              const body = document.getElementById('sheet-body');
              return body && !body.querySelector('.pending');
            }""",
            timeout=30000,
        )
        miss_text = page.inner_text("#sheet-body")
        check("no_definition_message", "no definition found" in miss_text.lower(), miss_text[:240])
        page.screenshot(path=str(out / "no-definition.png"), full_page=True)

        browser.close()

    report["ok"] = all(c["passed"] for c in report["checks"] if c["name"] != "https" or args.url.startswith("https://") or True)
    # For local http, https check is informational; overall ok requires the functional checks.
    required = [c for c in report["checks"] if c["name"] != "https"]
    if args.url.startswith("https://"):
        required = report["checks"]
    report["ok"] = all(c["passed"] for c in required)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"ok": report["ok"], "url": args.url, "artifact_dir": str(out)}, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
