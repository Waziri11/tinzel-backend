# Staff workspace and System page

Managers can manage designer accounts through `/api/manager/staff`; the same existing CRUD/onboarding handlers serve admin staff routes. Manager routes filter target roles on the server and forbid deletion and privileged-role changes. Open-order deactivation safeguards and session revocation remain active.

Staff can update only their name and phone with `PATCH /api/staff/profile`. Password changes and logout reuse the existing authenticated endpoints. Email and role are not self-service fields.

`GET /api/system/summary/:section` serves `runtime`, `storage`, and `messaging` independently to managers and admins. Samples are cached for 15 seconds per running instance. Storage includes MongoDB/GridFS, not external blob-store quotas. GridFS file bytes are part of database usage. Memory reports the current Node process and heap; hosting-wide free RAM and provider quotas are null when unavailable. A serverless instance's uptime is not application availability.

## Provider configuration

Admin-only `/api/admin/providers` returns field metadata, nonsecret effective values, source, and revision. `PUT /:provider` accepts `{ revision, values, remove }`. Empty inputs preserve saved settings; explicit `remove` entries restore environment defaults. Revisions prevent silent overwrites. `POST /:provider/check` checks the saved connection without sending messages. Existing explicit test-send actions retain notification history.

Set `PROVIDER_CONFIG_ENCRYPTION_KEY` in deployment configuration before saving secrets. Generate a stable key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Keep it outside source control and the database. Use the same key on all API instances and workers. Preserve it across deployments; replacing it without re-encrypting saved secrets makes them unreadable. This key is separate from `STAFF_CREDENTIAL_ENCRYPTION_KEY`.

NextSMS, SMTP, and Twilio/WhatsApp settings resolve saved overrides before environment defaults. Secret fields are encrypted using AES-256-GCM with per-field authenticated data. Responses never return secrets; audit entries record changed field names only. Runtime settings refresh within five seconds across instances, and immediately following a local save. SMTP and Twilio clients are recreated when effective credentials change. Twilio webhook validation uses the same saved auth token. Missing/wrong encryption keys fail closed.

Hosting, MongoDB, storage credentials, and encryption keys remain deployment-managed. No provider messages are sent simply by opening or saving the System page. Opening the messaging summary fetches the SMS balance, while email/Twilio connectivity checks are explicit admin actions.

## Verification

Run backend `npm test`, frontend `npm test`, and frontend `npm run build`. `tests/workspaceAccess.integration.test.js` uses an isolated MongoDB to cover manager role targeting, designer creation/deactivation, profile restrictions, system access, secret encryption/redaction, setting precedence, revisions, and admin-only provider operations.
