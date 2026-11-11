# Word Lens

A tiny iPhone-friendly PWA: point the camera at a page, freeze the frame, tap a word, and read its definition.

## How to use

1. Open the site in Safari on your iPhone (HTTPS required for the camera).
2. Tap **Open camera** and allow camera access.
3. Press the shutter. Word Lens reads the page and boxes each word.
4. Tap a word to see its phonetic, part of speech, and definitions.
5. Tap **Retake** to go back to the live camera.

To install it as an app: in Safari, tap Share → Add to Home Screen.

## Notes

- The camera uses the rear lens when it can (`facingMode: environment`).
- OCR runs entirely in the browser with Tesseract.js (English).
- Definitions come from [Free Dictionary API](https://dictionaryapi.dev/).
- Low-confidence and non-alphabetic tokens are ignored.

## Local development

Serve this folder over HTTPS or localhost:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.
