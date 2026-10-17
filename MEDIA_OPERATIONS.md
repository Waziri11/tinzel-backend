# Media uploads: operation and verification

## Shipping behavior

The new form uploader retains originals, uses one queue with two file transfers, and submits answers plus completed asset IDs. GridFS mode sends sequential 1 MiB parts per file. Parts have stable IDs and SHA-256 hashes: interruption, repeated requests, and refresh/reselection do not require re-sending acknowledged parts. Completed files release their browser File references. No large multipart fallback or lossy original compression remains in the new client.

Sessions and answers recover from browser storage for seven days. Browsers cannot silently restore local File access after a refresh: unfinished files must be reselected. Completed files remain available. Session finalization creates one order and audit event and returns the same receipt on retries. Existing orders, old GridFS URLs, and legacy disk references remain readable; no historical assets are migrated.

Defaults are 25 MiB per original, 100 files per session, and 1 GiB total. Existing form-specific photo limits still apply. Adjust `MEDIA_MAX_FILE_BYTES`, `MEDIA_MAX_FILES`, and `MEDIA_MAX_TOTAL_BYTES` to the magazine requirements after capacity testing. `photo_upload` accepts one file. The legacy multipart route is capped at 4,000,000 request bytes; old pages should be refreshed.

## Storage modes

- `MEDIA_STORAGE=gridfs` (default): requires only the existing MongoDB connection. Raw bytes go through the API in bounded 1 MiB parts; original files can exceed Vercel's request-size limit. This is resumable, but it is not direct-to-object-storage transport.
- `MEDIA_STORAGE=blob`: connect a **private** Vercel Blob store and set `BLOB_READ_WRITE_TOKEN`. New reservations then upload directly from the browser through short-lived grants. MongoDB retains the session/asset metadata. Existing GridFS assets remain readable. Blob transfers reconcile completion before retry; a partially transferred Blob file restarts that file after refresh. Part-level cross-refresh resume is currently provided by GridFS mode only.

Switching modes affects new reservations. Keep credentials for every provider containing existing originals. Never delete a storage bucket to roll back the application. Direct Blob operation needs a configured account and an end-to-end deployment check before enabling it; local tests exercise the GridFS transport.

## Preview and archive worker

`npm run media:worker` runs a persistent worker; append `-- --once` for one bounded batch. On Vercel, `vercel.json` schedules `/api/internal/media-jobs` every minute with a 300-second function budget. Set a strong `CRON_SECRET` in the target environment; Vercel sends it in the Authorization header. Work is awaited, not launched as a detached promise.

The worker uses a database lease so only one process decodes/generates archives at a time. It handles up to 100 jobs or 230 seconds per invocation, prioritizing requested archives. Failed/transient jobs retry at most three times. The database stores job state; expired leases allow recovery after an interrupted invocation. Inspect `MediaJob` records with `state=failed` for persistent errors before manually resetting attempts. Do not run a second independent media processor outside this lease.

Previews are at most 480px WebP; original bytes are retained. Unsupported image decoders (including some HEIC installations) leave the original downloadable and show a preview placeholder. Gallery requests are lazy and folders start collapsed except the first. Cached archives use ZIP store mode, batch metadata lookup, and lazy source streams. The browser polls job state, then follows an expiring download ticket; it does not collect the ZIP in a JavaScript Blob. The download rechecks the current staff account and assignment.

## Recovery, retention, and logs

Automatic original-upload expiry cleanup is **off by default**. Set `MEDIA_CLEANUP_ENABLED=true` only after adopting the seven-day recovery window plus one-day grace period. Cleanup reconciles session entries with orders, retains every referenced original, and reclaims abandoned chunks/assets. Finalizing sessions are excluded. This only applies to the new sessions, not pre-existing uploads. Re-creatable cached archives expire after 24 hours (`MEDIA_ARCHIVE_TTL_HOURS`); a later download request regenerates them. The worker records output IDs for every attempt and reclaims unused derivative/archive chunks on subsequent runs. Originals and referenced previews are excluded from derived-file reclamation.

Requests return `X-Request-Id`. Structured `media_request` logs include duration, request bytes, database wait, path, and status. `media_error` logs record the underlying storage error. `media_job` logs report job kind, attempt, elapsed time, and process RSS. Do not log image bytes, session tokens, or client answers. An upload error screen includes its reference when the server returns one.

The reported Birthday `/photos` 500 was not reproducible from retained production logs: the inspected current-deployment entries showed HTTP 201 responses. The earlier error's precise cause remains unconfirmed. Do not attribute that 500 to the 4.5 MB gateway limit; an oversized request normally returns 413.

## Validation commands and boundaries

- Backend: `npm test` (includes disposable-Mongo HTTP integration tests for original-byte preservation, part recovery, repeated completion/finalization, cancellation races, previews, archives, and cleanup retention).
- Frontend: `npm test`, `npm run build`, and `npm run test:e2e` from the sibling frontend. E2E needs a Chromium browser; the configuration defaults to installed Google Chrome, and `PLAYWRIGHT_CHANNEL` can select another installed channel. It starts an isolated MongoDB/backend and Vite on ports 5077/5177. It never loads production credentials.
- Service capacity check: `node scripts/mediaBenchmark.js`. Uses disposable MongoDB and synthetic 3 MiB files, with one/two per-session upload slots and scenarios up to 100 photos or ten simultaneous clients. It is not an Internet-upload benchmark.

Local benchmark on 17 October 2026: one 100-photo session completed service/database work in 1.11 seconds with 19 ms finalization. Ten simultaneous clients with ten files each completed in 1.21 seconds with 16 ms sampled p95 finalization. Sampled application RSS peaked at 236 MiB; this excludes MongoDB, browsers, network delay, and image decoding. These are a local baseline, not production latency or device-memory claims. The single-client scenarios contain one finalization sample each, so their p95 is not statistically meaningful.

Physical mobile-device testing, live Blob transfers, and the complete 1/2/10 Mbps production-like load matrix remain separate validation tasks. Browser tests cover mobile viewport and a throttled 2 Mbps interruption case; a viewport is not physical-phone evidence.

## Rollout

Deploy additive backend support and configure the worker first, verify its health, then deploy the frontend. Test a controlled original upload above 4.5 MB, compare downloaded bytes, wait for a thumbnail, and verify a staff folder download. Never load-test production. Rollback the frontend to its prior deployment if needed; keep new backend routes and storage reads for already-created orders. Deployment status and any controlled live-test evidence should be recorded separately from local test results.
