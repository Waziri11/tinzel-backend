# Fast magazine rollout and verification

The new paths are implemented behind compatibility switches. This document is an operator checklist, not deployment approval. No services or stores have been provisioned by this change.

## Configuration and order

1. Deploy the compatible API with `DRAFT_UPLOAD_PROVIDER=gridfs`. Existing sessions retain their own provider even after the default changes. Existing GridFS and legacy private draft sources remain readable. Cancelled Blob sessions deny application requests immediately and retain their cleanup record for one hour, allowing the last issued write-only token to expire before object deletion; incomplete multipart retention is managed by the storage provider.
2. In candidate regions measure database query round-trip latency, private range-read latency, and page derivative delivery. Select the lowest measured supported region; keep the API, database, store, and worker close where practical. Do not import the blueprint's region placeholder or assume `iad1`.
3. Connect a **private** Vercel Blob store. Set `DRAFT_BLOB_READ_WRITE_TOKEN` in the API and worker secret settings. This is separate from public client-photo credentials. Never place it in frontend variables. Verify anonymous GET fails and browser write-only authorization cannot read the original.
4. Build `docker build -f Dockerfile.proof-worker -t tinzel-proof-worker .`. The build runs the native canvas/PDF.js/WebP smoke test on Linux. Run with a staging database and private storage before provisioning production.
5. Review `deploy/render.proof-worker.yaml.template`: two `4c-8g` replicas, two isolated rendering processes each; an additional lightweight outbox process sends notifications. Fill in the measured region. Provisioning and costs require separate authorization. Set `PROOF_WORKER_MODE=dedicated` on the API/media worker to disable compatibility rendering there. Start `npm run proof:worker` on dedicated workers. Photo archive and cleanup workers remain separate.
6. Set `DRAFT_UPLOAD_PROVIDER=blob` on the API only after the worker and private-store checks pass. New sessions use direct 8MiB parts, four concurrent transfers and batched checkpoints; old GridFS sessions resume unchanged. Deploy the frontend. `PROOF_PAGE_BUNDLE=false` and `VITE_PROOF_FAST_READER=false` provide a bundle rollback; authenticated legacy page/text delivery remains available. Do not return original PDFs on rollback.
7. Observe queue age, failed job diagnostics, worker RSS/restarts and outbox retries. Stop enabling new Blob sessions on failure; preserve committed objects and existing sessions. No destructive source migration is needed.

Reference: [Vercel SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), [private storage](https://vercel.com/docs/vercel-blob/private-storage), [Render workers](https://render.com/docs/background-workers), [Blueprint specification](https://render.com/docs/blueprint-spec).

## Recover the affected production magazine

Use the production environment with read-only database credentials first:

```
npm run proof:diagnose -- 6ad3bc5c0d539e5d089b915f 1
```

If the reader displays a reference ID, look up that exact failure (including references retained in earlier attempts):

```
npm run proof:diagnose -- --reference REFERENCE_ID
```

Run this in the environment connected to the affected production database. A reference alone does not identify which dependency failed; inspect the returned `error`, `errorName`, and attempt history before changing packages.

The command reads the source's availability, stored attempts and errors, leases, derived-page metadata and runtime revision. It does not expose source URLs or modify jobs. Correlate reference IDs and job IDs with deployment logs. A missing order means the selected database is not the relevant production database; do not upload another copy as a workaround.

Repair the diagnosed issue (source availability, encrypted/invalid PDF, Linux dependencies, memory, timeout or worker lease). On Linux reproduce the existing source using the staging copy and native smoke test. The authenticated `/api/proofs/staff/ORDER_ID/VERSION/diagnostics` endpoint is limited to manager/admin. Once the cause is repaired, the existing reader's Retry preparation action resets failed jobs only and reuses the original PDF; already prepared pages remain available. Verify cover visibility, annotations and repeated reopen without new rendering before release. Deterministic failures do not retry automatically.

## Measurements

- `draft_finalized`: provider, size, duration; no email or rendering on the request path. The durable event is in the order write; outbox delivery is at-least-once across a process crash.
- `proof_job`: queue wait, whole job duration, RSS, job ID. Attempt records include lease acquisition, failures and reference IDs.
- `proof_page_phases`: source open, page render, derivative persistence, cumulative parser range bytes and output bytes. WebP is produced once. PDF.js caches one version per process and discards it on idle or after 60 seconds; processes cap JS heap at 2GiB. Native allocations still require deployment memory monitoring.
- Page bundles carry `Server-Timing: watermark`; the browser's `proof-page-decode` performance entries separate decoding. Network timings distinguish transfer from decoding. Base image cache is bounded to 16 entries/32MiB; watermarked cache to 40 entries/64MiB/60 seconds, keyed by derivative, viewer and reader-session nonce. Authentication and access audit still run on every response. Browser responses remain private/no-store.
- Browser pages: two loads at once, maximum ten decoded entries, current spread protected from eviction. Navigation aborts obsolete prefetches. Cover visibility does not depend on pages 2–5. No full-magazine eager queue.

## Staging load harness

`tinzel-frontend/scripts/benchmarkMagazines.js` uses real browser transfers and readers against your staging deployment. It commits drafts, so use five disposable orders that have passed correction gates and assigned-designer tokens. Keep its JSON input outside the repository with file permissions restricted. It never writes tokens into reports.

Input shape:

```json
{
  "baseUrl": "https://STAGING_HOST",
  "mbps": 20,
  "latencyMs": 200,
  "reportPath": "/tmp/tinzel-magazine-benchmark.json",
  "uploads": [{"orderId":"DISPOSABLE_ORDER","token":"DESIGNER_TOKEN","file":"/absolute/image-heavy-150MiB.pdf"}],
  "readers": [{"path":"/staff/design/orders/PREPARED_ORDER","token":"ASSIGNED_STAFF_TOKEN"}]
}
```

Supply exactly five uploads and twenty reader entries. Use 150MiB, 300MiB and 500MiB image-heavy PDFs, with separate disposable orders for subsequent runs. Run from the frontend directory:

```
node scripts/benchmarkMagazines.js /private/staging-benchmark.json --run
```

Run all nine 10/20/50Mbps × 100/200/300ms profiles. Throughput is shared across requests on each browser page; provision enough aggregate bandwidth for five upload connections. Reports contain measured durations and per-file targets, never inferred success. Reader measurements include navigation, making the prepared-cover target conservative. Repeat sufficiently for meaningful p95; 5 uploads alone give a very small sample. The harness exits unsuccessfully on failures or missed latency targets.

Additionally interrupt/reload/reselect, cancel, repeat completion, restart workers mid-page, request cross-batch spreads/distant correction links, and reopen historical versions. Inspect actual source denial and private-store access with every role. Preserve annotation coordinates and final print-file permissions. Capture source delivery and worker memory in Linux deployment telemetry.

## Current validation boundary

Local integration tests use real GridFS, PDF.js, native canvas and WebP. Blob protocol integration uses a stubbed private-storage adapter; frontend multipart tests exercise concurrency/checkpoints/resume but do not prove the live provider. The configured development database has no affected production version. Private Blob credentials and the production database secret are unavailable locally, and the Docker daemon is not running. Vercel CLI access was subsequently verified; the packaging diagnosis below records the available production evidence. Consequently the production failure, Linux compatibility, live 150/300/500MiB throughput and 5-upload/20-reader acceptance targets remain release gates, not claimed results.


## Vercel packaging diagnosis — 29 October 2026

Authenticated Vercel inspection confirmed production deployment `dpl_4BjdLYx4Bas4Ftgoqv126rRLURwT` uses commit `14de668`, Node.js 24, with the affected metadata job executed at 10:02:40 UTC (13:02:40 EAT). The production environment has neither `PROOF_WORKER_MODE=dedicated` nor the private Blob configuration enabled, so it is running the compatibility renderer and GridFS path.

A fresh standalone Vercel build of that code omitted `node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`, although `pdf.mjs` and the canvas binding were included. Loading a small valid PDF from the isolated function reproduced:

```
Setting up fake worker failed: "Cannot find module '…/pdfjs-dist/legacy/build/pdf.worker.mjs' imported from …/pdf.mjs".
```

PDF.js imports that worker at runtime. `vercel.json` now explicitly includes this asset. A second standalone build contains the worker and passes the full canvas/PDF/text/WebP smoke test when all package resolution is anchored in the isolated function directory. The original bundle fails the same test. This establishes a reproducible packaging defect that produces the screenshot's renderer-unavailable classification; the exact stored production exception remains unverified because Vercel redacts the sensitive database variable on export and the failure was not logged with its detailed error.

Reproduce before deployment:

```
vercel build --prod --standalone --output /tmp/tinzel-proof-build --yes
npm run proof:smoke -- --function-dir /tmp/tinzel-proof-build/functions/index.func
```

A macOS build checks bundle completeness using macOS native dependencies; it is not Linux runtime proof. Deploy through the normal Vercel Linux build, rather than uploading this macOS prebuilt bundle. After the backend is deployed, retry preparation for the existing version; no source re-upload is needed. Confirm the production job becomes ready before calling the live failure resolved. Deployment was not performed during diagnosis.
