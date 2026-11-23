# Word Lens

A tiny iPhone-friendly PWA: point the camera at a page, freeze the frame, tap a word, and read its definition.

## Live app

[https://echogitshadow.github.io/word-lens/](https://echogitshadow.github.io/word-lens/)

## How to use

1. Open the site in Safari on your iPhone (HTTPS required for the camera).
2. Tap **Open camera** and allow camera access.
3. Use **Photo** mode and press the shutter, or switch to **Live** and hold the crosshair over a word. Word Lens straightens the page if needed and boxes less-common words.
4. Tap a word to see its phonetic, part of speech, and definitions. Tap the speaker to hear the word. If the word looks wrong, tap it in the sheet and edit it, then press Search.
5. Tap **Show all** if you want boxes on common words too.
6. Tap **Retake** to go back to the live camera.

To install it as an app: in Safari, tap Share → Add to Home Screen.

## Notes

- The camera uses the rear lens when it can (`facingMode: environment`).
- OCR runs entirely in the browser with Tesseract.js (English).
- Definitions come first from a bundled offline extract of [WordNet 3.0](https://wordnet.princeton.edu/) and Webster's 1913 dictionary, then from Wiktionary, Datamuse, or the [Free Dictionary API](https://dictionaryapi.dev/) if needed. If the app looks up a base form such as *languid* for *languidly*, it says “from languid.”
- The speaker plays a recorded pronunciation when one is available, and otherwise uses the device’s spoken voice. That fallback also works offline.
- Low-confidence and non-alphabetic tokens are ignored.
- Photos with warm, cool, or dim lighting are color-corrected before OCR, and shadows are flattened so a dark patch of the page still reads. Dense or curved book pages are read in overlapping bands. Tight glare over a word can still hide it.
- On iPhone, the camera stays on the 1× wide back lens so it does not jump to ultra-wide when you get close. Hold a bit farther back if the page looks soft. **Live** mode watches the word under the crosshair and shows a short definition; tap it for the full sheet. Close-up shots are scaled so the letters stay a size the reader can handle.
- Sideways, upside-down, and moderately skewed photos are straightened for reading; boxes are mapped back onto the original photo.
- Very common words (the top 3,000 from the [Google Trillion Word Corpus list](https://github.com/first20hours/google-10000-english)) and very short words are hidden by default.

## Local development

Serve this folder over HTTPS or localhost:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.
