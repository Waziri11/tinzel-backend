# Magazine selection and image comments — 3 November 2026

## Behavior

The shared protected reader supports native text, English/Swahili OCR, detected PDF
images, and guided area selection for flattened collages. OCR uses the unwatermarked
page stored by the renderer. It runs on demand for visible pages in Select text mode,
in a lower-priority leased job; reading remains available during preparation or failure.
Native text takes precedence over overlapping OCR words. OCR is approximate, especially
for decorative lettering; area selection remains available.

Geometry schema 3 clips rotated image polygons at page edges rather than clamping each
corner. Existing images and saved annotations remain intact. Selection upgrades are lazy;
no bulk migration or backfill is needed. Page images are not fetched again when selection
metadata finishes. The watermark uses bundled Noto Sans through the canvas renderer,
removing dependence on the deployment host's SVG font configuration.

Manager and client comments may contain text, images, or both. Limits are five still
JPEG/PNG/WebP images per comment, 10 MiB per input, and 40 million decoded pixels.
Uploads use 1 MiB immutable, resumable chunks. The server decodes, auto-orients, and
re-encodes to WebP without source metadata, and generates thumbnails. Original upload
bytes are temporary, not downloadable attachments. Text remains limited to 4,000 characters.

Uploads and failed saves remain in the open composer for retry. Paste, drop, file selection,
removal, mobile navigation guards, preview enlargement, and bilingual labels are supported.
Saved images remain available after reload and in historical correction rounds. Only
unsaved browser drafts are lost on leaving after confirmation. Upload state is not persisted
on the user's device. Image-only checklist items have a bilingual generated description.

## Interfaces and lifecycle

Under the existing `/api/proofs/staff/:id/:version` and `/api/proofs/client/:version` scopes:

- `POST /prepare` accepts `{pages, ocr:true, retry?:true}`; page metadata exposes `ocrState`.
  Geometry responses add `ocrVersion` and merge native and OCR runs with normalized coordinates.
- `POST /attachments` reserves `{clientId,name,size,contentType}` and returns its ID, chunk
  size and confirmed chunk numbers/hashes. `PUT /attachments/:id/chunks/:n` accepts raw bytes.
- `POST /attachments/:id/complete` validates and returns a safe image descriptor.
  `DELETE /attachments/:id` expires an unused upload.
- `GET /attachments/:id` and `?thumbnail=1` require the same access as the linked annotation.
  A reviewer can also preview their own completed upload during active review.
- Annotation creation accepts `attachmentIds`. The server claims only ready, unexpired,
  same-author/order/version/source assets. Annotation responses include safe `attachments`
  descriptors. Mutation replays must match the original text, target and image IDs.

`ProofAttachment` records and dedicated `proofAttachments` GridFS files are private.
Media-worker maintenance removes expired unreferenced uploads after 24 hours and safely
cleans discarded attachments. Referenced historical/submitted images are retained.
Temporary upload chunks also have a TTL index to cover interrupted cleanup. No public
URLs or client-controlled storage paths are used. Existing annotation/version permissions,
optimistic concurrency, approval gates and correction links remain authoritative.

OCR runs with at most one recognition worker per Node process. Its WASM and English/Swahili
models are bundled in Vercel and Docker outputs, with leased-job deadlines and retries.
`assets/README.md` and `assets/SHA256SUMS` record source/license information.

## Local verification

Validation includes real image upload/normalization, multi-part resumption, invalid formats,
size/pixel/count limits, scoped visibility, retries, cleanup and historical access; native,
scanned and mixed text; rotated/clipped images; browser upload failure, paste/drop, image-only
comments, navigation guards, fullscreen/zoom, simulated mobile selection and review workflow.

`Dockerfile.proof-worker` runs PDF renderer and OCR/font smoke checks. The Linux ARM64
1800×2400 two-column English/Swahili fixture recognized 104 words with networking disabled,
logging 1,131 ms recognition time and 275,423,232 bytes process RSS. It also passed
with all system font directories removed (1,252 ms; 262,811,648 bytes RSS). This synthetic sample
is not a production latency or memory percentile.

No production deployment, bulk OCR, real customer mutations, provider messages or physical
phone tests were performed. For release, deploy backend support before frontend, verify
packaged assets and worker maintenance, then exercise OCR and image corrections on a
disposable review. Check `proof_ocr` timing/RSS and failed proof-job diagnostics.

Final local checks: 168 backend tests and 26 frontend tests passed; all 44 reader/review
browser scenarios passed across the full run and the corrected client-language fixture
rerun. Focused image/OCR browser checks were repeated after the final mobile layout and
translation adjustments. The production frontend build and whitespace checks passed.
The production dependency audit reported no known vulnerabilities. The local Linux VM
used for verification was stopped afterward; nothing was pushed or deployed.
