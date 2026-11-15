#!/usr/bin/env python3
"""Verify the definition-sheet speaker button on Word Lens."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {"url": args.url, "checks": [], "ok": False}

    def check(name: str, passed: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "passed": bool(passed), "detail": detail})
        print(f"[{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        page = context.new_page()
        page.set_default_timeout(30000)
        console_errors = []
        page.on("pageerror", lambda err: console_errors.append(str(err)))
        page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("#open-camera", timeout=15000)
        page.wait_for_function("() => window.__wordLensTest && window.__wordLensTest.openWord", timeout=15000)

        # Open a word that usually has dictionary audio + IPA.
        page.evaluate("() => window.__wordLensTest.openWord('remarkable')")
        page.wait_for_selector("#sheet.open", timeout=10000)
        page.wait_for_timeout(200)
        speak = page.locator("#sheet-speak")
        check("speaker button visible", speak.is_visible(), f"hidden={page.locator('#sheet-speak').get_attribute('hidden')}")
        check("aria-label", speak.get_attribute("aria-label") == "Play pronunciation", speak.get_attribute("aria-label") or "")

        # Install spies, then click. Playwright clicks count as a user gesture.
        page.evaluate(
            """() => {
              window.__speakLog = { uttered: [], audio: [], errors: [] };
              const synth = window.speechSynthesis;
              if (synth && !synth.__wordLensWrapped) {
                const orig = synth.speak.bind(synth);
                synth.speak = (utter) => {
                  window.__speakLog.uttered.push(utter && utter.text ? utter.text : "");
                  try { return orig(utter); } catch (err) {
                    window.__speakLog.errors.push(String(err));
                    throw err;
                  }
                };
                synth.__wordLensWrapped = true;
              }
              const OrigAudio = window.Audio;
              if (OrigAudio && !OrigAudio.__wordLensWrapped) {
                const Wrapped = function (...args) {
                  const audio = new OrigAudio(...args);
                  const origPlay = audio.play.bind(audio);
                  audio.play = () => {
                    window.__speakLog.audio.push(audio.src || audio.currentSrc || "");
                    return origPlay();
                  };
                  return audio;
                };
                Wrapped.prototype = OrigAudio.prototype;
                Wrapped.__wordLensWrapped = true;
                window.Audio = Wrapped;
              }
            }"""
        )

        speak.click()
        page.wait_for_timeout(800)
        log = page.evaluate("() => window.__speakLog")
        triggered = bool((log or {}).get("uttered") or (log or {}).get("audio"))
        check(
            "tap triggers audio or speech",
            triggered and not (log or {}).get("errors"),
            json.dumps(log),
        )

        # Wait briefly for prefetch + definition, then tap again (should prefer recorded audio if found).
        page.wait_for_timeout(3500)
        phonetic = page.locator("#sheet-phonetic").inner_text().strip()
        head = page.locator("#sheet-word").input_value()
        check("headword is the looked-up word", head == "remarkable", head)
        # IPA is best-effort (needs the dictionary API); record it either way.
        check("phonetic area present", page.locator("#sheet-phonetic").count() == 1, phonetic or "(empty before/without API)")

        page.evaluate("() => { window.__speakLog.uttered = []; window.__speakLog.audio = []; window.__speakLog.errors = []; }")
        speak.click()
        page.wait_for_timeout(800)
        log2 = page.evaluate(
            """() => ({
              log: window.__speakLog,
              playing: document.getElementById('sheet-speak').classList.contains('playing'),
              audioUrl: true
            })"""
        )
        triggered2 = bool((log2.get("log") or {}).get("uttered") or (log2.get("log") or {}).get("audio"))
        check("second tap still triggers playback", triggered2 and not (log2.get("log") or {}).get("errors"), json.dumps(log2))

        # Offline-style fallback: clear any prefetched URL and click; must speak via Web Speech.
        fallback = page.evaluate(
            """() => {
              window.__speakLog.uttered = [];
              window.__speakLog.audio = [];
              window.__speakLog.errors = [];
              // Reach into the app only through the click handler behavior:
              // empty audio by opening a nonsense word, then speak immediately.
              return true;
            }"""
        )
        page.evaluate("() => window.__wordLensTest.openWord('xyzzyq')")
        page.wait_for_timeout(150)
        speak.click()
        page.wait_for_timeout(600)
        log3 = page.evaluate("() => window.__speakLog")
        spoke = "xyzzyq" in ((log3 or {}).get("uttered") or [])
        check("unknown word falls back to speechSynthesis", spoke, json.dumps(log3))

        page.screenshot(path=str(out / "sheet-speak.png"), full_page=True)
        check("no page errors", not console_errors, "; ".join(console_errors))
        browser.close()

    report["ok"] = all(c["passed"] for c in report["checks"])
    (out / "speak-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"ok": report["ok"], "passed": sum(1 for c in report["checks"] if c["passed"]), "total": len(report["checks"])}, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
