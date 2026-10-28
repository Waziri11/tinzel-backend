# Protected magazine review

Review PDFs remain in private GridFS storage (or the existing private legacy draft directory). Browsers receive authenticated, viewer-watermarked WebP page images and positioned text, never the original PDF. Printed production documents retain their existing handoff.

## Runtime and rollout

- Node.js 22.13+ is required by PDF.js. Install optional platform packages for `@napi-rs/canvas`; do not use `npm ci --omit=optional` in the worker/deployment build.
- The root `npm run dev` starts the API, frontend, and media worker together. When starting the backend alone, also run `npm run dev:worker` from the root.
- The existing `/api/internal/media-jobs` scheduled worker prepares proof metadata and one page per leased job. A persistent worker can run `npm run media:worker` for faster preparation. Existing cron authorization remains required.
- Deploy backend and frontend together. Old raw proof view/download endpoints now return 403.
- Run `npm run backfill:proof-readers` against the intended database to enqueue existing versions; then run the worker. Opening an existing version also enqueues it on demand. The backfill only schedules derived assets and does not replace source PDFs.
- Preparation supports PDFs up to 100 MB and 500 pages. Failed jobs retry up to three times; authorized readers can request preparation retry. No raw-file fallback exists.
- Verify the target deployment's native canvas package and worker authorization with a real upload and scheduled rendering before declaring rollout complete. Local native rendering does not prove Linux deployment readiness.

## API

Staff: `/api/proofs/staff/:orderId/:version`; clients: `/api/proofs/client/:version`.

- `GET /`: processing state, page count, prepared page dimensions, permitted annotations, and `canComment`.
- `GET /pages/:page`: watermarked image; `?text=1` returns positioned text.
- `POST /annotations`: `{page, kind: 'text'|'area', rects:[{x,y,width,height}], selectedText, text}`. Rectangles use normalized displayed-page coordinates, including intrinsic PDF rotation.
- `DELETE /annotations/:id`: discard an unsubmitted review comment.
- `POST /retry`: retry failed preparation jobs for that version.

Existing manager/client return endpoints atomically submit saved comments as correction items; approval rejects pending comments. Order optimistic concurrency prevents simultaneous comment/review writes from silently overwriting each other. Submitted annotations stay immutable on their original version.

Page access is audited. Each process limits reader requests to 240 per viewer per minute; a distributed gateway rate limit should also be configured when scaling across instances. All reader responses are private/no-store. Screenshots, recording, and reconstruction of displayed pages/text cannot be prevented by a web app.

## Validation notes

Local native rendering, watermarks, text geometry including rotated PDFs, the manager/client correction round trip, original-file denial, and historical-version access are covered by `tests/proofReader.integration.test.js`. Browser coverage exercises designer/manager/client readers, area/text selection, failed-save recovery, zoom, responsive layouts, and version switching. Tests must exclude workstation service credentials: `DOTENV_CONFIG_PATH=/dev/null npm test`.

The backend dependency audit currently reports 8 existing findings (6 high, 2 moderate) in the unchanged Vercel Blob, body-parser, multer, nodemailer, qs, and Zod dependency chains. Renderer dependencies did not change those installed versions. These require separate dependency maintenance; the review reader is not a claim that the whole application is vulnerability-free.
