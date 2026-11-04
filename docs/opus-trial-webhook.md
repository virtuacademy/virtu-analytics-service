# Opus trial bookings → attrib

Opus (app.fortelessons.com) books trial lessons ("Meet & Greets") without Acuity. This contract
lets Opus report each booking here so Google Ads and HubSpot receive the same kind of
`TRIAL_BOOKED` conversion that Acuity bookings already produce.

Owners: this service owns the endpoint and the contract; Opus
(`server/providers/attrib/` in the Opus repo) is the only sender. Change both sides together and bump
`schemaVersion` for any breaking change.

## How a booking is attributed

Opus attribution works the way Acuity's does: the visit is captured by `/api/attrib/ingest`
when it happens, and only a token travels to the booking.

1. **Marketing site ingest.** Every page view on www.fortelessons.com calls
   `POST /api/attrib/ingest`, as virtu.academy's inline script does. This service's own cookies
   never reach another site (they are `SameSite=Lax` on `.virtu.academy`), so the marketing site
   stores the returned IDs in first-party cookies on `.fortelessons.com` and sends them back on
   the next call. That request and response, below, are the contract the marketing site follows.
2. **The token reaches Opus.** app.fortelessons.com shares `.fortelessons.com`, so the Opus
   server reads the `va_attrib` cookie when the trial is booked.
3. **Opus sends the token** as `attribution.vaAttrib` in `trial.booked`.
4. **attrib snapshots the ingest row.** The booking's own Attribution row is built from the
   visitor's ingest row as it stands at booking time, so later page views cannot change a past
   conversion. Opus's own capture (below) fills only the fields the ingest row lacks, for
   example a gclid seen only when the visitor landed directly in the app. Without a usable
   token, Opus's capture is the only source.

Opus's own capture: the fortelessons.com link helpers carry `gclid`, `gbraid`, `wbraid`,
`fbclid`, `ttclid`, `msclkid` and `utm_*` on links into the app, and Opus stores them in its
own first-party cookie when the visitor arrives.

### Ingest contract for the marketing site

`POST /api/attrib/ingest` with `content-type: application/json`, from an origin listed in
`ALLOWED_ORIGINS` (`https://www.fortelessons.com`, `https://fortelessons.com`). Send it without
credentials (`credentials: "omit"`); no cookie of this service is involved.

```json
{
  "url": "https://www.fortelessons.com/trial?utm_source=google&gclid=Cj0…",
  "referrer": "https://www.google.com/",
  "utm": { "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "trial", "utm_term": null, "utm_content": null },
  "click": { "gclid": "Cj0…", "gbraid": null, "wbraid": null, "dclid": null, "fbclid": null, "ttclid": null, "msclkid": null, "fbp": null, "fbc": null, "ttp": null },
  "hubspotutk": null,
  "vid": "<va_vid cookie, if set>",
  "sid": "<va_sid cookie, if set>",
  "attribTok": "<va_attrib cookie, if set>"
}
```

- `url` is the full page URL including its query string. It is stored as is and not parsed, so
  UTMs and click IDs must also be sent in `utm` and `click`. `referrer` is
  `document.referrer` or `null`.
- `click.fbp`, `click.fbc`, `click.ttp` and `hubspotutk` are the `_fbp`, `_fbc`, `_ttp` and
  `hubspotutk` cookies when present.
- `vid`, `sid` and `attribTok` are the values from the previous response. Each is used only if
  it is a UUID; anything else (including `opus_…`) gets a fresh ID. Omit them on the first visit.
- Each UTM field and click ID keeps its latest non-empty value across calls with the same
  `attribTok`; the first URL, referrer and touch time are kept, the last ones replaced.

Response: `{ "ok": true, "vid", "sid", "attribTok", "cookieDomain" }`. Store, on
`.fortelessons.com` with `Path=/`, `Secure`, `SameSite=Lax`, readable by JavaScript:

| Cookie | Value | Max age |
| --- | --- | --- |
| `va_attrib` | `attribTok` | 90 days |
| `va_vid` | `vid` | 90 days |
| `va_sid` | `sid` | 30 days (the service starts a new session after 30 idle minutes regardless) |

Rewrite all three after every response: the service may return new IDs.

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
    "vaAttrib": "0b6c5a1e-3f4d-4c2b-9a8e-7d6f5e4c3b2a",
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
- `attribution.vaAttrib` is the visitor's ingest token, the `va_attrib` cookie on
  `.fortelessons.com`, or `null`/absent. When it names a known ingest row, that row is the
  primary source (see "What gets recorded"). A value that is not a UUID, or an unknown one, is
  ignored rather than rejected, so the booking is recorded exactly as without it.
- The rest of `attribution` is Opus's own capture, from the visitor's visits to the app that
  arrived with a click ID or UTM:
  - `utm`: each field keeps its latest non-empty value (same rule as ingest).
  - `landingUrl`, `referrer` and `lastTouchAt` come from the latest such visit.
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
  `datetime = booking.startsAt`, `gclid`/`ttclid` from the snapshot, `vaAttrib` = the known
  ingest token (linking the visitor's visit history, as on an Acuity appointment) or else
  `eventId` (linking the snapshot), and
  `scheduledBy = "opus:staff"` for staff bookings.
- `Attribution` with `token = eventId`: a snapshot taken at booking time.
  - With a known `vaAttrib`, each of the UTMs, click IDs (`gclid`, `gbraid`, `wbraid`, `dclid`,
    `fbclid`, `ttclid`, `msclkid`), `fbp`, `fbc`, `ttp`, `hubspotutk`, first and last URL,
    referrer and touch time, `visitorId` and `sessionId` comes from the ingest row; the event's
    `attribution` fills only the fields the ingest row lacks.
  - Without one, every field comes from the event's `attribution`, touch times default to
    `occurredAt`, and `fbp`, `fbc`, `ttp`, `hubspotutk`, `visitorId` and `sessionId` are null.
  - `ipAddress` and `userAgent` always come from `client` (the booking request).
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
  `source_system = "opus"`, and the snapshot's `hubspotutk` as `utk` when the booking was linked
  to an ingest row. Acuity events keep `HUBSPOT_SOURCE_SYSTEM`.
- **IP address:** a linked booking's snapshot carries the ingest `sessionId`, so the worker
  sends that session's first IP and user agent (the landing visit), as for Acuity. An unlinked
  booking sends the booking request's.
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
