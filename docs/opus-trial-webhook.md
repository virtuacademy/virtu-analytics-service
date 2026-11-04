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
    "landingUrl": "https://app.fortelessons.com/teacher/profile/abc?utm_source=google&gclid=…",
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
  parent), never the learner. Opus does not send bookings made by account holders under 18.
- `valueCents` is the learner's total charge in integer cents, or `null`. The Google Ads action
  always uses its own default value, so this is informational.
- `client` is the booker's IP and user agent from the booking request.
- `attribution` is the last visit to the app that arrived with a click ID or UTM, as stored by
  Opus. Every field may be `null` (a direct or organic visit).
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
| 200 | `{ "ok": true, "eventId", "canonicalEventId", "queued" }` | Recorded; `queued` says whether any delivery was queued |
| 200 | `{ "ok": true, "eventId", "deduped": true, "requeued" }` | This `eventId` was already recorded; nothing was written |
| 400 | `{ "ok": false, "error" }` | Body does not match the contract; `error` names the fields. Do not retry unchanged |
| 401 | `{ "ok": false, "error" }` | Missing, bad or stale signature |
| 500 | `{ "ok": false, "error" }` | No secret configured, a database error, or (`"recorded": true`) recorded but not queued; resend |

Recording is idempotent by `eventId`, so a resend is always safe. A resend also queues any
delivery that was recorded but never attempted (`requeued: true`), which repairs a request that
failed between recording and queuing. Staff bookings add `"skippedOutbound": true`.

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
  `GOOGLE_ADS_CONVERSION_ACTIONS` (for example
  `TRIAL_BOOKED=7447834932,opus:TRIAL_BOOKED=<Opus action ID>`). Opus events never fall back to
  the Acuity action; without the mapping the delivery is `SKIPPED`.
- **HubSpot:** sends the same `HUBSPOT_EVENT_NAMES` event as Acuity, with
  `source_system = "opus"`. Acuity events keep `HUBSPOT_SOURCE_SYSTEM`.
- `GOOGLE_ADS_VALIDATE_ONLY=true` uploads are recorded as `SKIPPED`, not `SUCCESS`, for both
  booking systems: Google checks them but records nothing.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPUS_WEBHOOK_SECRET` | attrib | Shared HMAC secret. The endpoint answers 500 without it. |
| `OPUS_DELIVERY_PLATFORMS` | attrib | Comma list of `GOOGLE_ADS`, `HUBSPOT`. Empty means record only. |
| `GOOGLE_ADS_CONVERSION_ACTIONS` | attrib | Add `opus:TRIAL_BOOKED=<id>`. |
| `ATTRIB_WEBHOOK_URL` | Opus | Full endpoint URL. Opus sends nothing without it. |
| `ATTRIB_WEBHOOK_SECRET` | Opus | Same value as `OPUS_WEBHOOK_SECRET`. |
