# Protected review assets

These files are bundled with the backend and its worker. Recognition never downloads
language models or sends magazine pages to another service at runtime.

- `ocr/eng.traineddata`, `ocr/swa.traineddata`: Tesseract `tessdata_fast`, from
  https://github.com/tesseract-ocr/tessdata_fast (downloaded 3 November 2026).
  Apache 2.0 license: `ocr/LICENSE`.
- `fonts/NotoSans.ttf`: Noto Sans variable font from
  https://github.com/google/fonts/tree/main/ofl/notosans (downloaded 3 November 2026).
  SIL Open Font License: `fonts/OFL.txt`. Registered as `Tinzel Watermark` at runtime.

The committed bytes, dependency lockfile, and checksums below define the tested assets.
Use `npm run proof:ocr-smoke` to validate model loading and positional recognition.
