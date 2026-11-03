# Authentication and account recovery

Implemented locally on 2026-11-03. Deployment and real provider delivery are separate release steps.

## Production configuration

Configure `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_HOSTNAMES` on the backend. Hostnames are a comma-separated exact allowlist without schemes or paths. Use a Cloudflare Turnstile managed widget restricted to these same frontend hostnames. Both keys are required; only the site key is returned by `/api/staff/auth-config`. Do not use Cloudflare test keys in production.

Production login and recovery requests fail closed if configuration or verification is unavailable. The server validates success, hostname, and the `login` or `recovery` action. Cloudflare validates token expiry and single use. Development/test skips CAPTCHA only when no secret key is configured; there is no production bypass switch. The frontend CSP permits the Cloudflare script, frame, and connection origins.

Existing NextSMS settings deliver OTPs. SMTP and SMS settings deliver security alerts. Authentication alerts bypass marketing/workflow notification preferences. Configure the existing authenticated notification cron (`/api/internal/notification-jobs`, `CRON_SECRET`) or run `npm run notifications:worker`; alerts also attempt delivery after the request. Alerts are persisted before delivery, retried up to five attempts after reported failures, and marked unconfirmed before sending so interrupted/uncertain deliveries are not automatically duplicated. Inspect unconfirmed/failed notification records when investigating provider outages.

Password creation and replacement require outbound HTTPS to `api.pwnedpasswords.com`. The server sends only the first five characters of a SHA-1 password hash with padded responses, never the password or full hash. Outages block password changes with a retry message; existing login still works. Tests use synthetic provider responses and do not send real credentials. `PASSWORD_BREACH_CHECK=true` enables that check in test mode; production always checks it.

## User flows and limits

- Forgot password accepts an email and always returns the same response shape, with an opaque challenge identifier. Account lookup and SMS delivery run after the response, preventing provider timing or delivery failures from disclosing account membership. Ineligible accounts receive no code. Users may resend after 60 seconds; a fresh code invalidates its predecessor.
- SMS codes expire after five minutes, allow five guesses, are stored as keyed hashes, and are consumed once. Recovery OTPs cannot authenticate a login. Verification exchanges a code for a five-minute, single-use password-reset grant kept only in page memory.
- Reset grants are tied to the account credential version, role and contact details. Password updates use conditional writes, so concurrent resets or administrative account changes cannot silently overwrite newer credentials. Expired onboarding passwords can be recovered. Disabled/deleted accounts cannot be recovered or reactivated.
- Resetting a password revokes sessions, trusted devices, pending challenges, and old initial-credential deliveries. It does not sign the user in. Normal password changes also invalidate prior access and create a replacement session; privileged users still need SMS verification before protected work.
- New passwords require at least 15 Unicode characters, block obvious common/repeated values and known breached passwords, and support spaces. Bcrypt imposes a 72 UTF-8 byte maximum, enforced before hashing; the UI explains this limit. Existing and short temporary onboarding passwords remain valid for their existing flows. Temporary passwords must be replaced with a full passphrase.
- Login is limited independently by account (10 requests/15 minutes) and IP (50/15 minutes), plus the existing combined limit. Recovery requests allow five/account and 20/IP per 15 minutes. OTP sending also has a one/minute purpose/account cooldown, five/account and 20/IP per 15 minutes, 20/account/day, 30/destination/day, and 1,000 total/day. These caps bound provider costs; review the global cap before expanding staff volume. Limits persist in MongoDB and fail closed when it is unavailable.
- Trusting a device is an explicit unchecked choice at privileged SMS verification. Trust duration follows the existing administrator-configured policy. A separate browser-recognition cookie suppresses repeated new-browser alerts; it never grants a session or bypasses OTP.
- Ordinary sign-out ends only the current session. The Security panel lists the current account's live sessions and trusted devices, allows individual revocation, and offers “Sign out everywhere and forget devices.” Revocation requires recent SMS verification. Removing trust alone does not terminate an active session; its session must also be revoked.
- Security activity is recorded without passwords, OTPs, CAPTCHA tokens, or reset grants. The account activity view shows the latest 50 events. New-browser sign-ins, password changes/resets, and recovery-phone changes generate bilingual in-app, SMS, and email alerts. Contact changes notify both old and new phone numbers.

## Assisted recovery

Only a recently SMS-verified administrator can assist an active manager or designer. The administrator must independently verify identity using a previously known staff contact or in person, record a method and case reference (20–500 characters, no identity documents or passwords), and confirm that verification. An OTP sent to the replacement phone must be verified before the phone changes. The challenge is bound to that administrator's current session and the target account's credential/contact state. The action is audited with actor, target, case reference and IP; it revokes the target's previous access and notifies old/new contacts. The account owner then uses Forgot password.

Self-service phone replacement requires verification of the current account phone and then the replacement phone. Administrator accounts cannot use assisted recovery through this screen; recovering an administrator who has lost their phone requires the organization's separate controlled recovery procedure. No unauthenticated phone-change or administrator bypass has been added.

## Release validation

Local checks: 190 backend tests, 30 frontend tests, the production frontend build, and 11 browser tests against the production preview passed. Both repositories passed whitespace/diff checks.

Automated tests exercise recovery eligibility, incorrect codes, expiry, resend invalidation, purpose separation, reset replay/concurrency, deactivation/contact changes, expired onboarding recovery, session isolation/CSRF, opt-in trust, administrator restrictions, SMS caps, CAPTCHA action/hostname checks and provider failure, breached-password queries, and alert delivery claims.

Browser tests exercise English/Kiswahili recovery, mobile layout, dialog accessibility, password-manager/OTP input attributes, session inventory and revocation, CAPTCHA failure/retry, and the existing login/onboarding flows. Provider calls are simulated or captured by the disposable local test sink.

Before deploying both applications, configure the real Turnstile widget and verify a real login, OTP recovery, SMS/email alert, and notification cron in the target environment. Check CAPTCHA with the deployed CSP and real frontend hostname. These live checks have not been performed locally.

References: [Cloudflare server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [OWASP recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), [Pwned Passwords API](https://haveibeenpwned.com/API/v3#PwnedPasswords).
