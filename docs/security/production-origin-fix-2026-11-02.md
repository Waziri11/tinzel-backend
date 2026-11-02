# Production password-setup origin fix — 2026-11-02

The live password setup returned HTTP 403 with `Request verification failed`. Production had neither `FRONTEND_URL` nor `ALLOWED_ORIGINS`, leaving the cookie-session mutation origin allowlist empty.

Added production `FRONTEND_URL=https://tinzel.stryxis.com` to the existing backend Vercel project. Redeployed the existing production artifact `dpl_6EbiwLWUKYFN3oxb1H3fcJHQHcxr`; new deployment `dpl_4FRQk7xyAaU8cibFBwWmQcxMhp67` became Ready and was aliased to `tinzel-backend.stryxis.com`. No local code changes or pending commits were published as part of this redeployment.

At 15:46 Tanzania time, a preflight through the live frontend proxy to `/api/staff/change-password` returned 204 with the exact Tinzel origin, credential allowance, and CSRF header allowance. An unrelated origin received no CORS allow-origin header. CSRF token validation remains enabled. This verifies deployment configuration; the user's actual password replacement must be completed by the user and was not performed during diagnosis.

Reload the setup page to obtain the current session CSRF token before retrying. If its short setup session has expired, sign in again with the still-valid initial credential. No password or token is included in this record.
