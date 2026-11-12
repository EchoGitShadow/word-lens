# Word Lens

A tiny iPhone-friendly PWA: point the camera at a page, freeze the frame, tap a word, and read its definition.

## Live app

[https://echogitshadow.github.io/word-lens/](https://echogitshadow.github.io/word-lens/)

## How to use

1. Open the site in Safari on your iPhone (HTTPS required for the camera).
2. Tap **Open camera** and allow camera access.
3. Press the shutter. Word Lens straightens the page if needed and boxes less-common words.
4. Tap a word to see its phonetic, part of speech, and definitions. If the word looks wrong, tap it in the sheet and edit it, then press Search.
5. Tap **Show all** if you want boxes on common words too.
6. Tap **Retake** to go back to the live camera.

To install it as an app: in Safari, tap Share → Add to Home Screen.

## Notes

- The camera uses the rear lens when it can (`facingMode: environment`).
- OCR runs entirely in the browser with Tesseract.js (English).
- Definitions come from [Free Dictionary API](https://dictionaryapi.dev/), with a Wiktionary fallback if that request fails.
- Low-confidence and non-alphabetic tokens are ignored.
- Photos with warm, cool, or dim lighting are color-corrected before OCR. Tight glare over a word can still hide it.
- Sideways, upside-down, and moderately skewed photos are straightened for reading; boxes are mapped back onto the original photo.
- Very common words (the top 3,000 from the [Google Trillion Word Corpus list](https://github.com/first20hours/google-10000-english)) and very short words are hidden by default.

## Local development

Serve this folder over HTTPS or localhost:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.
