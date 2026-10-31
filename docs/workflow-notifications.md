# Workflow handoff notifications

Order saves append workflow events in the same atomic write as the status/assignee change. The resumable photo submission upsert embeds its initial event under a stable submission-session key. Ordinary reads, preferences and unchanged saves create no events. Only future transitions and existing pending draft events are processed; historical orders are not backfilled.

The notification worker sends in-app notices and SMS, plus email when present. Active managers/admins receive management tasks; the assigned active designer receives design tasks; the customer receives their order's notices. The printer receives a WhatsApp document message and a companion SMS. Pending deliveries recheck the task, version, assignment and recipient activation before each send.

## Saved language

- Staff: `StaffUser.preferredLanguage` (`en`/`sw`), returned by login and `/api/staff/me`; `PATCH /api/staff/preferences` updates only the authenticated staff account.
- Customer: `Order.clientPreferredLanguage`, accepted by both form submission paths and returned in authenticated tracking; `PATCH /api/client/preferences` updates only the token's order.
- Printer: `printer_preferred_language` SystemConfig key, editable by an admin under Notifications → Notification Triggers & Settings.
- Missing legacy choices default to Kiswahili. Tinzel's existing language switch saves subsequent choices. The recipient's preference is read again before delivery/retry. Historical sent text is preserved.

## Delivery and recovery

`workflowEvents` records the event key, task identity/version, recipients and worker lease inside the order. `Notification.deliveryKey` has a unique partial index on event + recipient + channel. These internal events are removed from order API responses.

A queued delivery attempt is saved before the provider call. Accepted phone/email messages use `sent` (displayed as **provider accepted**); only a delivery callback may mark them delivered. In-app records use delivered. Missing contacts produce visible failures; disabled channels are skipped. Simulation is explicitly labeled.

Only confirmed transient rejections are automatically retried, after 1, 5, 15 and 60 minutes, with five total attempts. A timed-out/interrupted send is unconfirmed and never blindly repeated. Staff can retry failed deliveries using the same event/channel; unconfirmed deliveries require acknowledgement that a duplicate is possible. Attempts are retained across manual retry cycles. Successful channels are not repeated, and obsolete tasks reject retries.

`GET /api/internal/notification-jobs` requires `Authorization: Bearer $CRON_SECRET`. Its Vercel cron runs every minute. Immediate delivery is attempted after each transition; the bounded worker recovers after interruptions. Locally run `npm run notifications:worker`, or `npm run notifications:worker -- --once` for one pass. Do not run against a live database to test providers.

Before production rollout, configure the existing channel credentials/settings and staff phone numbers, `FRONTEND_URL`, `BACKEND_URL` (the public API origin), and `CRON_SECRET`. Ensure the new Notification and Order indexes are built. Deploy backend support before the frontend. Provider acceptance is not inbox/handset delivery; live delivery must be checked separately with authorized recipients.

## Protected printer files

WhatsApp receives `/api/print-jobs/:orderId/:eventKey/file?exp=…&sig=…`, valid for seven days. The signature, authorized print event, file path and upload timestamp must all match. The endpoint supports private Blob, GridFS and existing local print storage, returns private/no-store PDF responses, and rejects missing, expired, tampered or superseded capabilities. It does not expose a source-magazine download link to customers or designers.

## Customer inbox

`GET /api/client/notifications` returns only in-app notifications for the authenticated order and customer recipient role; `PATCH /api/client/notifications/:id/read` uses the same scope. Responses omit external contact/delivery metadata. Staff and customer views refresh every 30 seconds while visible and on focus; polling stops after logout.

## Local validation

`npm test` in each repository runs backend integration/unit and frontend unit checks. `npx playwright test tests/browser/workflow-notifications.spec.js` exercises language persistence, accurate channel outcomes, controlled retry, printer language settings, mobile customer notifications, read state and polling/logout. Backend workflow integration checks exercise real HTTP transitions from submission through correction loops to delivery with explicitly isolated simulated providers; they also cover concurrent workers, retry limits, interruption recovery, legacy events, stale tasks, recipient privacy, language defaults and signed print access.
