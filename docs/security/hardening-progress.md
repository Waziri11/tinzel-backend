# Security hardening implementation ledger — 2026-11-02

Local implementation is complete. Production deployment and external infrastructure verification remain separate release gates. No commits were pushed and no production configuration or data was changed.

| Plan step | Implementation commits | Verification |
|---|---|---|
| 1. Media bypasses | `1969fbf`, `e9e48b2`, `ff1b5b2` | Forged credentials, private drafts, scoped photos, blocked static print and unknown upload directories |
| 2. Central RBAC | `51c28fe`, `9212919`, `1cc5926` | Role/action/resource matrix, assignment and current-account checks, management integration tests |
| 3. Durable audit | `f3ddff6`, `e9e48b2`, `ff1b5b2` | Pre-transfer failure blocks delivery; interruption/retry; append-only interface; redaction/export retry |
| 4. Staff downloads | `e9e48b2`, `ff1b5b2`; frontend `528ff5a` | Correct bytes/hash, recent OTP, designer/anonymous denial, visible audit history |
| 5. Authentication | `735a048`, `06e0fd8`; frontend `bd8c4e9`, `e2a1004`, `01a3daa` | OTP channels, replay/concurrency/expiry/limits/provider failure, CSRF, contact/session revocation |
| 6. Printer access | `e9e48b2`, `1cc5926`; frontend `528ff5a`, `01a3daa` | SMS-bound invitation, exact-file hash, recipient/file/status/expiry/revocation checks, old route 410 |
| 7. Previews | `48ce624`, `9212919` | Server-burned identity/session watermarks; current released version; revoked session denied |
| 8. Harvesting | `48ce624`, `9212919`, `06e0fd8` | Shared identity limits survive view-ID/IP-header changes; durable alert; normal reader regression |
| 9. Configuration | `0f48e43`, `ff1b5b2`; frontend `e2a1004` | Independent production keys, exact origins, production CSP browser verification |
| 10. Regression/evidence | `06e0fd8`, `1cc5926`; frontend `6ec49cb` and documentation commit | See verification report in frontend `docs/security/security-hardening-verification.md` |

See [rollout requirements](rollout.md) for required production configuration and rollback constraints. Preview recipients can capture screenshots or photographs; originals are controlled, previews are attributable, and future access is revocable. Revocation cannot erase bytes already delivered.
