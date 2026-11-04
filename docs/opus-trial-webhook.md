# Opus trial bookings → attrib

Opus (app.fortelessons.com) books trial lessons ("Meet & Greets") without Acuity. This contract
lets Opus report each booking here so Google Ads and HubSpot receive the same kind of
`TRIAL_BOOKED` conversion that Acuity bookings already produce.

Owners: this service owns the endpoint and the contract; Opus
(`server/providers/attrib/` in the Opus repo) is the only sender. Change both sides together and bump
`schemaVersion` for any breaking change.

## Why the click ID travels in the payload

Acuity bookings never leave virtu.academy, so `/api/attrib/ingest` captures the click ID at
landing and only the `va_attrib` token travels. Opus traffic lands on www.fortelessons.com and
books on app.fortelessons.com, neither of which can read `.virtu.academy` cookies. Instead:

1. The fortelessons.com link helpers carry `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid` and
   `msclkid` (plus `utm_*`) on links into the app.
2. Opus stores them in a first-party cookie when the visitor arrives.
3. When the trial is booked, the Opus server reads that cookie and sends the values here.

## Request

`POST /api/webhooks/opus`

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-opus-timestamp` | Unix time in seconds when the request was signed |
| `x-opus-signature` | `v1=` + hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` keyed with the shared secret |

The shared secret is `OPUS_WEBHOOK_SECRET` here and `ATTRIB_WEBHOOK_SECRET` in Opus. Requests
whose timestamp is more than 5 minutes from the server clock are rejected, which limits replay
of a captured request; resends re-sign with a fresh timestamp.

### Body (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "type": "trial.booked",
  "eventId": "opus_<lessonId>",
  "occurredAt": "2026-11-04T18:22:05.000Z",
  "booking": {
    "lessonId": "<lessonId>",
    "startsAt": "2026-11-10T23:00:00.000Z",
    "durationMinutes": 30,
    "instrument": "Piano",
    "valueCents": 3500,
    "currency": "USD",
    "invoicePaid": true
  },
  "contact": {
    "email": "parent@example.com",
    "phone": "+15555550123",
    "firstName": "Pat",
    "lastName": "Example"
  },
  "client": { "ip": "203.0.113.7", "userAgent": "Mozilla/5.0 …" },
  "attribution": {
    "landingUrl": "https://app.fortelessons.com/teacher/profile/abc",
    "referrer": "https://www.fortelessons.com/",
    "firstTouchAt": "2026-11-04T18:01:44.000Z",
    "lastTouchAt": "2026-11-04T18:01:44.000Z",
    "utm": { "source": "google", "medium": "cpc", "campaign": "trial", "term": null, "content": null },
    "click": { "gclid": "Cj0…", "gbraid": null, "wbraid": null, "fbclid": null, "ttclid": null, "msclkid": null }
  },
  "flags": { "staffInitiated": false }
}
```

- `eventId` is always `opus_` + `booking.lessonId`. The prefix keeps Opus IDs apart from Acuity's
  numeric appointment IDs, and the value is the Google Ads `order_id` and HubSpot `event_id`.
- `occurredAt` is when the lesson was booked. It becomes the conversion time.
- `contact` is the person who made the booking (the signed-in account holder, usually a
  parent), never the learner. Opus decides which bookings to report
  (`shouldReportTrialBooking`); attrib records whatever it receives.
- `valueCents` is Opus's `learnerTotalCostCents`: the trial's price to the learner in integer
  cents, including the processing fee and before any discount code or account credit (or
  `null`). It is stored as the canonical event value (`valueCents / 100`) and uploaded as the
  Google Ads conversion value, but the Opus conversion action is set to use the same value for
  each conversion ($280, matching the Acuity action), so Google ignores the uploaded value.
- `client` is the booker's IP and user agent from the booking request.
- `attribution` is what Opus stored from the visitor's visits to the app that arrived with a
  click ID or UTM:
  - `utm`, `landingUrl`, `referrer` and `lastTouchAt` come from the latest such visit. A visit
    with any UTM replaces the whole UTM set rather than mixing campaigns.
  - Each `click` ID is the latest one for its platform, from whichever visit brought it, dropped
    once it is more than 90 days older than the booking. An ad click followed by a newsletter
    visit therefore sends the ad's gclid with the newsletter's UTMs.
  - `firstTouchAt` is the first such visit.
  - `landingUrl` and `referrer` are origin and path only; click IDs and UTMs travel only in
    `click` and `utm`.
  - Every field may be `null` (a direct or organic visit).
- `flags.staffInitiated` is `true` when Forte staff booked while impersonating the account.
  Such bookings are recorded but never delivered, like staff-booked Acuity appointments.
- Required: `schemaVersion`, `type`, `eventId`, `occurredAt`, `booking.lessonId` (letters,
  digits, `_` and `-`, at most 128), `booking.startsAt`, `booking.durationMinutes` (positive
  integer), `booking.currency` (three upper-case letters), `booking.invoicePaid`,
  `flags.staffInitiated`, and the `contact`, `client`, `attribution`, `attribution.utm` and
  `attribution.click` objects. Every other field may be `null` or omitted.
- Datetimes are ISO 8601 with `Z` or an offset (`Date.prototype.toISOString()` output).
- String fields are capped at 2048 characters (URLs, user agent) or 512 (everything else).
  Longer values are rejected with 400, so the sender truncates. Unknown fields are ignored.

## Response

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "ok": true, "eventId", "canonicalEventId", "queued" }` | Recorded. See `queued` below |
| 200 | `{ "ok": true, "eventId", "deduped": true, "requeued" }` | This booking's event already exists; see resends below |
| 400 | `{ "ok": false, "error" }` | Body does not match the contract; `error` names the fields. Do not retry unchanged |
| 401 | `{ "ok": false, "error" }` | Missing, bad or stale signature |
| 409 | `{ "ok": false, "eventId", "error": "Conflicting record for this eventId" }` | A row with this ID exists but is not this booking's event. Nothing written; needs investigation, not a resend |
| 500 | `{ "ok": false, "error" }` | No secret configured, a database error, or (`"recorded": true`) recorded but not queued |

- `queued: true` means the deliveries were handed to QStash. That hand-off is a no-op when
  `QSTASH_TOKEN` or `PUBLIC_BASE_URL` is unset, so `queued` does not prove a worker will run.
  `queued: false` means every delivery was written as `SKIPPED` (or none, for staff bookings).
- **Resends.** Recording is deduplicated by `eventId`: when a `TRIAL_BOOKED` event for this
  appointment already exists, the resend writes nothing and answers `deduped: true`. Its
  deliveries are queued again (`requeued: true`) only if the event is more than 10 minutes old
  and still has a delivery that is `PENDING` with no attempts, which repairs a request that
  recorded the event but failed to queue it. Within those 10 minutes the first request's queue
  message may still be on its way, and requeuing then could deliver twice.
- Staff bookings add `"skippedOutbound": true`.

## What gets recorded

One transaction writes:

- `InboundWebhook` with `source = "opus"`, `action = "trial.booked"`, `externalId = eventId`.
- `Appointment` with `id = eventId`, `status = "scheduled"`, the contact fields,
  `datetime = booking.startsAt`, `gclid`/`ttclid` from the click IDs, `vaAttrib = eventId`
  (it links the Attribution row the way an Acuity `va_attrib` token does), and
  `scheduledBy = "opus:staff"` for staff bookings.
- `Attribution` with `token = eventId`, built from `attribution` and `client`.
- `CanonicalEvent` `TRIAL_BOOKED` with `eventTime = occurredAt` and `value = valueCents / 100`.
- `Delivery` rows for `GOOGLE_ADS` and `HUBSPOT` only. A platform not listed in
  `OPUS_DELIVERY_PLATFORMS` is written as `SKIPPED`, so Opus deliveries start switched off.

## Delivery

The existing QStash worker sends the deliveries.

- **Google Ads:** uploads to the action mapped as `opus:TRIAL_BOOKED` in
  `GOOGLE_ADS_CONVERSION_ACTIONS`. Production:
  `TRIAL_BOOKED=7447834932,opus:TRIAL_BOOKED=7889634403`, where 7889634403 is "Attrib - Opus
  Trial Lesson Scheduled" (created 2026-11-04 as a secondary action with the Acuity action's
  settings). Opus events never fall back to the Acuity action; without the mapping the delivery
  is `SKIPPED`.
- **Consent:** like Acuity uploads, Opus uploads mark `adUserData` and `adPersonalization` as
  granted, and nothing checks the visitor's cookie choice on the marketing site. Gating Opus
  reports on Termly advertising consent is planned for v2: the marketing site's link helpers
  would carry click IDs plus a consent marker only after consent, checked in the browser when
  the link is clicked.
- **HubSpot:** sends the same `HUBSPOT_EVENT_NAMES` event as Acuity, with
  `source_system = "opus"`. Acuity events keep `HUBSPOT_SOURCE_SYSTEM`.
- `GOOGLE_ADS_VALIDATE_ONLY=true` uploads are recorded as `SKIPPED`, not `SUCCESS`, for both
  booking systems: Google checks them but records nothing.
- An Opus event is only ever delivered to a platform that is `GOOGLE_ADS` or `HUBSPOT` and is
  listed in `OPUS_DELIVERY_PLATFORMS` when the worker runs; any other delivery row is marked
  `SKIPPED` without calling the platform.
- `va_attrib` values shaped like `opus_…` are never accepted from a browser: ingest replaces a
  cookie that is not one of its UUID tokens, and the Acuity webhook ignores such an intake
  value.

### Rollout

A delivery recorded as `SKIPPED` (its platform was off in `OPUS_DELIVERY_PLATFORMS`, or Google
ran in validate-only mode) is never delivered later, even after the setting changes. Turn each
platform on, and validate-only off, before the bookings you want delivered.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPUS_WEBHOOK_SECRET` | attrib | Shared HMAC secret. The endpoint answers 500 without it. |
| `OPUS_DELIVERY_PLATFORMS` | attrib | Comma list of `GOOGLE_ADS`, `HUBSPOT`. Empty means record only. |
| `GOOGLE_ADS_CONVERSION_ACTIONS` | attrib | Add `opus:TRIAL_BOOKED=7889634403`. |
| `ATTRIB_WEBHOOK_URL` | Opus | Full endpoint URL. Opus sends nothing without it. |
| `ATTRIB_WEBHOOK_SECRET` | Opus | Same value as `OPUS_WEBHOOK_SECRET`. |
