# Security hardening implementation ledger — 2026-11-02

This is an incomplete implementation. Do not describe it as release-ready or deploy it as the completed security plan.

## Completed commits

- `1969fbf`: rejects arbitrary upload headers, generic bearer JWTs, and anonymous development reads in signed-media verification; blocks static print PDFs. Six focused tests passed.
- `51c28fe`: introduces deny-default permission policies and connects staff proof/order resource checks. Five focused tests passed. Remaining route/service integration is outstanding.
- `48ce624`: restricts client previews to the latest approved release, preserves that release during internal review, rate-limits readers by identity plus IP, and adds stable actor IDs/IP to new page records. Five focused tests passed.
- `f3ddff6`: adds append-only security-event model, immutable-event outbox, leased HTTPS export worker, secret field exclusion, and 365-day retention. Three tests passed, including retry after delivery failure. Download integration is outstanding.
- `0f48e43`: requires JWT_SECRET and a separate MEDIA_SIGNING_SECRET in production; removes database-derived signing fallback and broad wildcard CORS. Seven focused tests passed.

## Validation

Full backend suite: 141 tests passed, zero failed (npm test).
Computer use against disposable MongoDB and local ports 5077/5177: manager sign-in succeeded; Users view showed only the two synthetic designer accounts and only the designer role filter. These are baseline checks, not completion of the planned browser matrix.

## Required deployment configuration

Set independent strong JWT_SECRET and MEDIA_SIGNING_SECRET values (at least 32 characters). Configure exact FRONTEND_URL/ALLOWED_ORIGINS. Existing media links will become invalid when the signing key changes. Configure SECURITY_AUDIT_EXPORT_URL (HTTPS) and SECURITY_AUDIT_EXPORT_TOKEN and schedule authenticated GET /api/internal/security-audit-export. The receiver must deduplicate Idempotency-Key/eventId and use separately protected storage. These infrastructure settings have not been verified.

## Outstanding implementation

1. Resource-scoped media authentication/revocation beyond transferable signed links; central permission enforcement throughout routes and services.
2. Wire durable auditing to access decisions and downloads; build staff audit search UI and transfer outcomes. Verify database permissions and protected export infrastructure.
3. Implement email/SMS OTP choice, privileged sign-in and recent verification, contact verification, opaque HttpOnly cookie sessions, CSRF and revocation. No production OTP test delivery bypass.
4. Implement audited original downloads for admin/manager and corresponding UI.
5. Replace reusable printer links with 24-hour invitations plus designated-phone OTP; ten-minute exact-file sessions; revoke/reissue UI. Existing printer bearer route remains active.
6. Add revocable client sessions and server-issued preview sessions, watermark session references, per-delivery audit, harvest alerts, and text-geometry restrictions.
7. Add/test frontend CSP and migration/deployment documentation.
8. Complete frontend regression/build, entire browser acceptance matrix through computer use, screenshots and final acceptance evidence.

Keep committing each coherent verified change. No push or deployment has been performed.
