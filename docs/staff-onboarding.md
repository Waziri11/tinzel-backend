# Staff onboarding and initial passwords

Administrators create staff accounts with a name, email, Tanzanian SMS phone number, role, language and optional designer capacity. The API generates an eight-character cryptographically random password with uppercase, lowercase, digit and special characters; ambiguous `0/O/1/l/I` characters are excluded. Administrators no longer enter or retrieve passwords.

The initial password is valid for 24 hours from issue. SMS and email use the recipient's English/Kiswahili preference. Account creation and delivery outcomes are separate: an account can exist while a channel is failed, skipped, simulated, or awaiting provider confirmation. Provider acceptance is displayed separately from confirmed delivery.

## First sign-in

A correct initial password issues a setup-purpose token lasting at most 15 minutes and never beyond the initial-password expiry. The server allows only `/api/staff/me`, `/api/staff/preferences`, `/api/staff/change-password` and `/api/staff/logout` until setup is complete. Other staff APIs return `PASSWORD_CHANGE_REQUIRED`; expired credentials return `INITIAL_PASSWORD_EXPIRED`.

`POST /api/staff/change-password` accepts `currentPassword` and `newPassword`. The new password must differ from the current one and contain at least eight characters, uppercase, lowercase, a number and a special character. The bcrypt input limit is 72 UTF-8 bytes. The update compares the current hash, token version and credential generation atomically, so a simultaneous reset/change cannot overwrite newer credentials. Success clears temporary state and encrypted delivery material, increments the token version, and returns a new normal token and public profile. The browser keeps only the token and clears the password fields. Uncompleted setup survives refresh and bookmarked workspace links.

New designers are excluded from automatic and manual assignment until setup is complete. Their configured capacity and eligibility are retained. Existing accounts without onboarding fields remain normal accounts; no password reset, retrospective welcome message, periodic expiry, or customer OTP change is applied. Trusted bootstrap seed commands retain their existing behavior.

## Administrator APIs and recovery

- `POST /api/admin/staff`: requires name/email/phone/role; accepts preferredLanguage `en`/`sw`; rejects a supplied password. Returns a public account and redacted per-channel delivery summary.
- `POST /api/admin/staff/:id/initial-password`: issues a new eight-character password, resets expiry to 24 hours, invalidates existing sessions, and queues SMS/email atomically with the new generation.
- `POST /api/admin/staff/:id/credential-delivery/retry`: accepts `channel` (`sms`/`email`) and optional `confirmUncertain`. Only current, valid credentials may be retried. Unknown provider acceptance requires explicit acknowledgement of possible duplication.
- Ordinary account edits reject password fields. Existing role, deactivation, deletion and last-admin safeguards remain in effect.

Admin user details show Awaiting first sign-in, Initial password expired or Ready, plus actual channel outcomes. Issue new initial password handles forgotten/expired passwords; there is no public self-service recovery flow.

## Delivery and sensitive data

`StaffUser` stores `mustChangePassword`, `temporaryPasswordExpiresAt`, `passwordChangedAt`, `credentialGeneration`, safe `credentialDelivery` summaries, and a private `credentialJob`. The hash and encrypted job never appear in account responses. The job is saved in the same account write as issuance, and uses AES-256-GCM with a random IV and authenticated staff ID/generation. Plaintext credentials exist only in memory while generating, verifying or dispatching them. Notification bodies are persisted as `[REDACTED]`; APIs, audit entries, diagnostics and provider errors must never retain credential text or encrypted payloads.

The existing protected notification cron/local worker also processes staff credential jobs. Atomic leases and unique per-user/generation/channel delivery keys prevent concurrent duplication. Confirmed transient failures retry after 1, 5, 15 and 60 minutes, for five total attempts. Successful channels are retained. Interrupted/uncertain sends are not automatically repeated. Reissue, deactivation, deletion, password completion or expiry stops obsolete work. Ciphertext is deleted on password completion or when the worker sweeps expired/inactive jobs. Security channel settings are honored; disabled channels are recorded as skipped.

## Configuration and rollout

Set `STAFF_CREDENTIAL_ENCRYPTION_KEY` to the base64 encoding of **32 cryptographically random bytes** before issuing credentials. Keep this secret outside source control. Missing or invalid configuration returns `STAFF_CREDENTIAL_CONFIG_REQUIRED` before creating or resetting an account. Preserve the configured key while pending credentials remain valid; changing it makes those encrypted delivery payloads unreadable and requires reissue under the new key.

Continue using the existing SMTP, SMS, `FRONTEND_URL` and protected cron configuration. The worker command remains `npm run notifications:worker` (`-- --once` for a single pass). Ensure the staff job-state index and notification delivery-key index exist. Deploy backend support first, followed by the frontend. No schema backfill or forced reset is required for existing users. Live SMS/email delivery and production deployment require separate authorization.

## Verification

Backend integration tests exercise generated length/classes, admin creation, encrypted storage/redacted responses, both channels/languages, first-login API restrictions, expiry, reissue, session revocation, assignment gates, disabled/partial delivery, retry limits, interruption recovery, concurrent workers/changes, encryption recovery, callback generation checks and legacy accounts. Frontend browser journeys exercise admin creation/status/reissue and desktop/mobile setup, mismatch validation, refresh, token replacement and navigation. Providers are isolated/simulated during local verification.
