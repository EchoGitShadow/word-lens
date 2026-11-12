#!/usr/bin/env python3
"""Lookup-quality suite for literary and inflected words."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

WORDS = [
    "languidly",
    "lugubrious",
    "sesquipedalian",
    "ineffable",
    "perfunctorily",
    "obsequiousness",
    "quixotic",
    "susurrus",
    "ephemeral",
    "sycophantic",
    "pulchritude",
    "defenestration",
    "perspicacious",
    "obstreperous",
    "mellifluous",
    "callipygian",
    "intransigence",
    "haplessly",
    "sonorous",
    "ebullient",
    "peregrination",
    "taciturn",
    "verisimilitude",
    "logorrhea",
    "incorrigible",
    "fastidiously",
    "recalcitrant",
    "grandiloquent",
    "pusillanimous",
    "antediluvian",
    "cynosure",
    "apocryphal",
    "redolent",
    "winsomely",
    "insouciance",
    "trenchantly",
    "sesquipedalianism",
    "lachrymose",
    "penultimate",
    "ubiquitous",
    "serendipitous",
    "quintessence",
    "superfluous",
    "disingenuously",
    "magnanimously",
    "incontrovertible",
    "belligerence",
    "sophistry",
    "wistfully",
    "lugubriously",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4173/")
    parser.add_argument("--out", default="/workspace/word-lens/tests/artifacts/dict-after.json")
    parser.add_argument("--label", default="after")
    args = parser.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_default_timeout(180000)
        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_selector("#open-camera")
        results = page.evaluate(
            """async (words) => {
              const out = [];
              const lemmas = window.__wordLensTest.lemmaCandidates('languidly');
              for (const word of words) {
                const t0 = performance.now();
                try {
                  const data = await window.__wordLensTest.lookup(word);
                  const meanings = [];
                  for (const entry of data || []) {
                    for (const meaning of entry.meanings || []) {
                      const def = (meaning.definitions || []).map((d) => d.definition).find(Boolean);
                      if (def) meanings.push({ pos: meaning.partOfSpeech, def });
                    }
                  }
                  out.push({
                    word,
                    ok: meanings.length > 0,
                    source: data && data._source || null,
                    queried: data && data._queried || null,
                    from: data && data._from || "",
                    def: meanings[0] && meanings[0].def || null,
                    pos: meanings[0] && meanings[0].pos || null,
                    ms: Math.round(performance.now() - t0),
                  });
                } catch (err) {
                  out.push({
                    word,
                    ok: false,
                    error: String(err && err.message || err),
                    ms: Math.round(performance.now() - t0),
                  });
                }
              }
              return { lemmas, results: out };
            }""",
            WORDS,
        )
        browser.close()

    rows = results["results"]
    ok = sum(1 for row in rows if row.get("ok"))
    print(f"[{args.label}] {ok}/{len(rows)}")
    print("languidly lemmas:", results["lemmas"])
    for row in rows:
        flag = "PASS" if row.get("ok") else "FAIL"
        from_word = f"  from {row['from']}" if row.get("from") else ""
        print(f"  {flag:4} {row['word']:22} src={row.get('source') or row.get('error')}{from_word}  {(row.get('def') or '')[:90]}")

    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "label": args.label,
                "ok": ok,
                "total": len(rows),
                "lemmas_languidly": results["lemmas"],
                "results": rows,
            },
            indent=2,
        )
        + "\n"
    )
    print("wrote", path)


if __name__ == "__main__":
    main()
