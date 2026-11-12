#!/usr/bin/env python3
"""Build compact per-letter definition chunks from WordNet 3.0 and Webster 1913."""

from __future__ import annotations

import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

WN_ROOT = Path("/home/box/nltk_data/corpora/wordnet")
WEBSTER = Path("/tmp/dictsrc/webster.json")
FREQ = Path("/tmp/dictsrc/en_50k.txt")
OUT_DIR = Path("/workspace/word-lens/dict")

# Keep abstract/literary noun lex files even when the word is rare.
KEEP_NOUN_LEX = {3, 4, 7, 9, 10, 11, 12, 16, 19, 22, 23, 24, 25, 26, 28}
POS_CODE = {"n": "n", "v": "v", "a": "a", "s": "a", "r": "r"}
MAX_DEFS = 2
MAX_LEN = 200
USEFUL_SUFFIX = re.compile(
    r"(ly|ness|ism|ity|ties|ment|tion|sion|ance|ence|ship|hood|tude|ation|ative|able|ible|ous|less|ful|ward|wise|logy|rhea|esque|ulous|acious)$"
)
SEE_ONLY = re.compile(r"^(See|Cf|Same as|Written also)\b", re.I)


def clean_word(token: str) -> str:
    token = token.replace("_", " ")
    if "(" in token:
        token = token[: token.index("(")]
    token = unicodedata.normalize("NFKC", token).strip().lower()
    token = token.replace(" ", "-")
    if not re.fullmatch(r"[a-z]+(?:['-][a-z]+)*", token):
        return ""
    return token


def clean_gloss(gloss: str) -> str:
    text = gloss.strip()
    cut = re.search(r';\s*[“"]', text)
    if cut:
        text = text[: cut.start()]
    text = re.sub(r"\s+", " ", text).strip(" ;")
    if len(text) > MAX_LEN:
        clipped = text[:MAX_LEN]
        if " " in clipped:
            clipped = clipped.rsplit(" ", 1)[0]
        text = clipped.rstrip(" ,;:-") + "…"
    return text


def parse_wordnet() -> tuple[dict, dict, dict]:
    entries: dict[str, list[list[str]]] = defaultdict(list)
    seen: dict[str, set[str]] = defaultdict(set)
    word_lex: dict[str, set[int]] = defaultdict(set)
    word_pos: dict[str, set[str]] = defaultdict(set)
    for name in ("data.noun", "data.verb", "data.adj", "data.adv"):
        path = WN_ROOT / name
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line or not line[0].isdigit() or "|" not in line:
                continue
            meta, gloss = line.split("|", 1)
            parts = meta.split()
            if len(parts) < 5:
                continue
            pos = POS_CODE.get(parts[2])
            if not pos:
                continue
            try:
                lex = int(parts[1])
                w_cnt = int(parts[3], 16)
            except ValueError:
                continue
            definition = clean_gloss(gloss)
            if len(definition) < 8:
                continue
            i = 4
            for _ in range(w_cnt):
                if i >= len(parts):
                    break
                word = clean_word(parts[i])
                i += 2
                if not word:
                    continue
                word_lex[word].add(lex)
                word_pos[word].add(pos)
                key = f"{pos}|{definition}"
                if key in seen[word] or len(entries[word]) >= MAX_DEFS:
                    continue
                seen[word].add(key)
                entries[word].append([pos, definition])
    return entries, word_lex, word_pos


def load_freq() -> set[str]:
    words = set()
    if FREQ.exists():
        for line in FREQ.read_text(encoding="utf-8").splitlines():
            if line.strip():
                words.add(line.split()[0].lower())
    return words


def should_keep(word: str, word_pos: dict, word_lex: dict, freq: set[str]) -> bool:
    poses = word_pos.get(word, set())
    lexs = word_lex.get(word, set())
    if "a" in poses or "r" in poses:
        return True
    if word in freq:
        return True
    if lexs & KEEP_NOUN_LEX:
        return True
    if USEFUL_SUFFIX.search(word) and "v" in poses:
        return True
    return False


def clean_webster(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\[(?:Obs|R|Archaic|Colloq|Cant)\.?\]\.?\s*", "", text)
    first = re.split(r"(?<=[.!?])\s+(?=[A-Z(“\"])", text, maxsplit=1)[0]
    return clean_gloss(first)


def merge_webster(entries: dict, freq: set[str]) -> int:
    raw = json.loads(WEBSTER.read_text(encoding="utf-8"))
    added = 0
    for key, text in raw.items():
        word = clean_word(str(key).lower())
        if not word or word in entries:
            continue
        if word not in freq and not USEFUL_SUFFIX.search(word):
            continue
        definition = clean_webster(str(text))
        if not definition or len(definition) < 12 or SEE_ONLY.match(definition):
            continue
        entries[word] = [["", definition]]
        added += 1
    return added


def main() -> None:
    all_entries, word_lex, word_pos = parse_wordnet()
    freq = load_freq()
    entries = {w: d for w, d in all_entries.items() if should_keep(w, word_pos, word_lex, freq)}
    wn_count = len(entries)
    added = merge_webster(entries, freq)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.json"):
        old.unlink()

    by_letter: dict[str, dict[str, list[list[str]]]] = defaultdict(dict)
    for word, defs in entries.items():
        letter = word[0] if word[0] in "abcdefghijklmnopqrstuvwxyz" else "_"
        by_letter[letter][word] = defs

    sizes = []
    for letter, chunk in sorted(by_letter.items()):
        path = OUT_DIR / f"{letter}.json"
        payload = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
        path.write_text(payload, encoding="utf-8")
        sizes.append((letter, len(chunk), path.stat().st_size))

    total_bytes = sum(s for _, _, s in sizes)
    summary = {
        "wordnet_words": wn_count,
        "webster_added": added,
        "total_words": len(entries),
        "letters": {letter: {"words": words, "bytes": size} for letter, words, size in sizes},
        "total_bytes": total_bytes,
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"WordNet kept:  {wn_count}")
    print(f"Webster added: {added}")
    print(f"Total words:   {len(entries)}")
    print(f"Total size:    {total_bytes} bytes ({total_bytes/1024/1024:.2f} MB)")
    for letter, words, size in sizes:
        print(f"  {letter}: {words:6} words  {size/1024:7.1f} KB")


if __name__ == "__main__":
    main()
