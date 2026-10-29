# Protected magazine review

Review PDFs remain in private GridFS storage (or the existing private legacy draft directory). Browsers receive authenticated, viewer-watermarked WebP page images and positioned text, never the original PDF. Printed production documents retain their existing handoff.

## Runtime and rollout

- Node.js 22.13+ is required by PDF.js. Install optional platform packages for `@napi-rs/canvas`; do not use `npm ci --omit=optional` in the worker/deployment build.
- The root `npm run dev` starts the API, frontend, and media worker together. When starting the backend alone, also run `npm run dev:worker` from the root.
- The existing `/api/internal/media-jobs` scheduled worker prepares proof metadata and one page per leased job. A persistent worker can run `npm run media:worker` for faster preparation. Existing cron authorization remains required.
- Deploy backend session/preparation support before the updated frontend. Old raw proof view/download endpoints now return 403.
- Run `npm run backfill:proof-readers` against the intended database to enqueue existing versions; then run the worker. Opening an existing version also enqueues it on demand. The backfill only schedules derived assets and does not replace source PDFs.
- Preparation supports PDFs up to 500 MB (500 MiB) and 500 pages. Failed jobs retry up to three times; authorized readers can request preparation retry. No raw-file fallback exists.
- Verify the target deployment's native canvas package and worker authorization with a real upload and scheduled rendering before declaring rollout complete. Local native rendering does not prove Linux deployment readiness.

## API

Staff: `/api/proofs/staff/:orderId/:version`; clients: `/api/proofs/client/:version`.

- `GET /`: processing state, page count, prepared page dimensions, opening-page readiness, failed page numbers, permitted annotations, and `canComment`.
- `POST /prepare`: `{pages:[pageNumber, optionalSecondPageNumber]}` requests the corresponding five-page batches and awaits at most six leased jobs within a 55-second request budget. Page images remain private and watermarked.
- `GET /pages/:page`: watermarked image; `?text=1` returns positioned text.
- `POST /annotations`: `{page, kind: 'text'|'area', rects:[{x,y,width,height}], selectedText, text}`. Rectangles use normalized displayed-page coordinates, including intrinsic PDF rotation.
- `DELETE /annotations/:id`: discard an unsubmitted review comment.
- `POST /retry`: retry failed preparation jobs for that version.

Existing manager/client return endpoints atomically submit saved comments as correction items; approval rejects pending comments. Order optimistic concurrency prevents simultaneous comment/review writes from silently overwriting each other. Submitted annotations stay immutable on their original version.

Page access is audited. Each process limits reader requests to 240 per viewer per minute; a distributed gateway rate limit should also be configured when scaling across instances. All reader responses are private/no-store. Screenshots, recording, and reconstruction of displayed pages/text cannot be prevented by a web app.

## Validation notes

Local native rendering, watermarks, text geometry including rotated PDFs, the manager/client correction round trip, original-file denial, and historical-version access are covered by `tests/proofReader.integration.test.js`. Browser coverage exercises designer/manager/client readers, area/text selection, failed-save recovery, zoom, responsive layouts, and version switching. Tests must exclude workstation service credentials: `DOTENV_CONFIG_PATH=/dev/null npm test`.

The backend dependency audit currently reports 8 existing findings (6 high, 2 moderate) in the unchanged Vercel Blob, body-parser, multer, nodemailer, qs, and Zod dependency chains. Renderer dependencies did not change those installed versions. These require separate dependency maintenance; the review reader is not a claim that the whole application is vulnerability-free.


## Large draft uploads and opening-page batches

The previous single multipart request could fail at the hosting gateway (Vercel function bodies above 4.5 MB return 413), the application upload ceiling (previously 100 MiB), or the renderer (also previously 100 MiB). Raising only the application limit does not bypass the gateway. The old multipart endpoint remains for small compatible requests; the new interface always uses 1 MiB authenticated parts.

Designer/admin endpoints under `/api/designer/orders/:id/draft-uploads`:

- `POST /`: `{name,size,contentType,fingerprint,expectedVersion,designerNotes,revisionRequestId?,verifyAll?}` creates a private 24-hour session, returning `id`, part size, and acknowledged chunk hashes.
- `GET /:uploadId`: resume status; requires the initiating staff member and current order access.
- `PUT /:uploadId/chunks/:n`: one binary part with `X-Chunk-SHA256`; retries cannot replace acknowledged bytes.
- `POST /:uploadId/complete`: verifies completeness and review gates, then commits one version. The order's session reference is the durable receipt for interrupted completion responses.
- `DELETE /:uploadId`: cancels an open transfer. The worker removes expired/cancelled uncommitted chunks and files. Session expiry extends with acknowledged uploads.

The browser remembers session metadata, never file bytes or credentials. Reselecting the same file verifies a header/tail fingerprint and the hashes of previously acknowledged chunks. Progress shows transferred bytes, speed, estimated remaining time when measurable, reconnecting, and finalizing; only a confirmed committed draft reaches 100%. Reduced-motion settings disable the animated ellipsis.

The reader prepares only the first five pages on initial opening. It downloads and decodes those images and positioned text with two concurrent page loads before showing the book. Later navigation requests five-page batches, including both batches for a spread crossing a boundary. A ten-page LRU cache releases evicted image URLs. Existing generated pages are reused; old eagerly queued jobs lacking `requested:true` are ignored until requested. The worker prioritizes requested reader jobs and uses private GridFS/filesystem range reads with PDF.js auto-fetch disabled. No original-PDF browser endpoint is introduced.

Opening requests can trigger bounded leased rendering directly, so production readers do not depend solely on the next cron tick. Keep the cron/persistent worker available for retries, cleanup, and processing that outlasts a request. Verify native rendering, runtime memory, and gateway behavior on the target deployment before calling it released.

### Local large-file validation

`tests/draftUpload.integration.test.js` sends valid 120 MiB and 500 MiB PDFs through a local gateway enforcing a 4.5 MiB request ceiling. It tests acknowledged-part resume, duplicate completion, integrity rejection, stale versions, authorization, cancellation, and cleanup. Separate image-heavy 120 MiB coverage renders five of twenty pages and asserts later pages remain unrequested. Synthetic fixtures are reproducible test PDFs, not the customer's original magazine.

Observed isolated local runs: 120 MiB transfer/initial/later batches about 1.5 seconds with 253 MiB peak process RSS; 500 MiB about 2.9 seconds with 388 MiB peak RSS; parser metadata/page lookup consumed 128 KiB for each padded fixture. The image-heavy 120 MiB fixture prepared five pages in about 1.3 seconds with 339 MiB peak process RSS. These are local measurements, not production throughput or memory guarantees. The final suite may vary with parallel test load.
