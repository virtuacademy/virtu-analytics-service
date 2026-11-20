# Opus trial bookings and accounts → attrib

Opus (app.fortelessons.com) books trial lessons ("Meet & Greets") without Acuity. This contract
lets Opus report each booking here so Google Ads, HubSpot and Meta receive the same kind of
`TRIAL_BOOKED` conversion that Acuity bookings already produce (see "Delivery").

Opus also reports each new account here, a family's and a teacher's as separate events, so
Google Ads and Meta can count and bid on signups (see "Accounts").

Owners: this service owns the endpoint and the contract; Opus
(`server/providers/attrib/` in the Opus repo) is the only sender. Change both sides together and bump
`schemaVersion` for any breaking change.

## How a booking is attributed

Opus attribution works the way Acuity's does: the visit is captured by `/api/attrib/ingest`
when it happens, and only a token travels to the booking.

Two sites can hand the token to Opus. Only the second does today:

- **www.fortelessons.com**, as in steps 1 and 2 below. It does not report to ingest yet.
- **lessons.virtu.academy**, the paid-ads trial page. It reports each page view with
  credentials, so this service sets `va_attrib` on `.virtu.academy` itself. Opus cannot read
  that domain's cookies, so the page's links into the app carry the token as a `va_attrib`
  query parameter, and Opus keeps it in its own host-only cookie (90 days; the newest link
  wins). The links gain the token only once the first page-view report has answered, so a
  visitor who clicks through sooner arrives without it.

1. **Marketing site ingest.** Every page view on www.fortelessons.com calls
   `POST /api/attrib/ingest`, as virtu.academy's inline script does. This service's own cookies
   never reach another site (they are `SameSite=Lax` on `.virtu.academy`), so the marketing site
   stores the returned IDs in first-party cookies on `.fortelessons.com` and sends them back on
   the next call. That request and response, below, are the contract the marketing site follows.
2. **The token reaches Opus.** app.fortelessons.com shares `.fortelessons.com`, so the Opus
   server reads the `va_attrib` cookie when the trial is booked.
3. **Opus sends the token** as `attribution.vaAttrib` in every event.
4. **attrib snapshots the ingest row.** The booking's own Attribution row is built from the
   visitor's ingest row as it stands at booking time, so later page views cannot change a past
   conversion. Opus's own capture (below) fills only the fields the ingest row lacks, for
   example a gclid seen only when the visitor landed directly in the app. Without a usable
   token, Opus's capture is the only source.
5. **Replays cannot drift.** An ingest row whose `lastTouchAt` is later than `occurredAt` plus 10
   minutes has seen visits after the booking (a resend or replay days later could otherwise pick
   up a newer gclid), so it is treated as unknown and Opus's capture, frozen at booking, is used
   alone. The 10 minutes cover clock skew and the delay between booking and sending.

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
    "click": { "gclid": "Cj0…", "gbraid": null, "wbraid": null, "fbclid": null, "ttclid": null, "msclkid": null,
               "fbp": "fb.1.1730000000000.1234567890", "fbc": null, "ttp": null },
    "hubspotutk": "0123456789abcdef0123456789abcdef"
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
  primary source (see "What gets recorded"). A value that is not a UUID, an unknown one, or one
  whose ingest row was touched more than 10 minutes after `occurredAt` is ignored rather than
  rejected, so the booking is recorded exactly as without it.
- The rest of `attribution` is Opus's own capture, from the visitor's visits to the app that
  arrived with a click ID or UTM:
  - `utm`: each field keeps its latest non-empty value (same rule as ingest).
  - `landingUrl`, `referrer` and `lastTouchAt` come from the latest such visit.
  - Each `click` ID is the latest one for its platform, from whichever visit brought it, dropped
    once it is more than 90 days older than the booking. An ad click followed by a newsletter
    visit therefore sends the ad's gclid with the newsletter's UTMs.
  - `click.gclid` is the newer of that capture and the `_gcl_aw` cookie that Google's Conversion
    Linker (GTM, all pages of both sites) stores on `.fortelessons.com`, so a visitor who
    reached the app through a link that no longer carried the gclid still has it.
  - `click.fbp`, `click.fbc`, `click.ttp` and `hubspotutk` are the `_fbp`, `_fbc` (Meta
    pixel), `_ttp` (TikTok pixel) and `hubspotutk` (HubSpot tracking script, after consent)
    cookies at booking, read by Opus's server and validated. `fbp` and `fbc` go to Meta with
    a delivered booking, `hubspotutk` goes to HubSpot as the event's `utk`, and `ttp` is stored
    for later TikTok delivery. Staff bookings send none of them.
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

### Accounts (`account.created`, `teacher_account.created`)

Sent once when an account is created: `account.created` for a learner or a parent,
`teacher_account.created` for a teacher. They are separate events so each has its own
conversion action in Google Ads and its own event name in Meta. Same endpoint, headers,
signature and `schemaVersion: 1` as a booking; a new `type` is not a breaking change.

```json
{
  "schemaVersion": 1,
  "type": "account.created",
  "eventId": "opus_account_<userId>",
  "occurredAt": "2026-11-20T15:04:05.000Z",
  "account": { "userId": "<userId>" },
  "contact": {
    "email": "parent@example.com",
    "phone": "+15555550123",
    "firstName": "Pat",
    "lastName": "Example"
  },
  "client": { "ip": "203.0.113.7", "userAgent": "Mozilla/5.0 …" },
  "attribution": { "…": "exactly as in trial.booked" },
  "flags": { "staffInitiated": false }
}
```

- `eventId` is always `opus_account_` + `account.userId` (letters, digits, `_` and `-`, at most
  128), whichever of the two types it is. One user is one event: a resend is deduplicated, and
  the same user reported under the other type is answered 409.
- `occurredAt` is when the account was created. It becomes the conversion time.
- `contact` is the new account's own email, phone and name. Opus decides which signups to
  report (no one under 18, no staff address); attrib records whatever it receives.
- `client` is the IP and user agent of the signup request.
- `attribution` has the same fields and rules as in `trial.booked`: `vaAttrib` links the
  visitor's ingest row, and the rest is Opus's own capture.
- There is no `booking` and no value. The conversion value comes from `EVENT_VALUES` here
  (`opus:ACCOUNT_CREATED=<USD>`, `opus:TEACHER_ACCOUNT_CREATED=<USD>`); without an entry no
  value is stored or sent.
- `flags.staffInitiated` is `true` when Forte staff created the account. It is recorded and
  never delivered.
- Required: `schemaVersion`, `type`, `eventId`, `occurredAt`, `account.userId`,
  `flags.staffInitiated`, and the `contact`, `client`, `attribution`, `attribution.utm` and
  `attribution.click` objects. Every other field may be `null` or omitted. Limits and datetime
  format are those of `trial.booked`.

A booking's `eventId` is `opus_<lessonId>` and an account's `opus_account_<userId>`. They share
one namespace, so a lesson ID must never begin with `account_`; Opus IDs are UUIDs.

## Response

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "ok": true, "eventId", "canonicalEventId", "queued" }` | Recorded. See `queued` below |
| 200 | `{ "ok": true, "eventId", "deduped": true, "requeued" }` | This very event already exists; see resends below |
| 400 | `{ "ok": false, "error" }` | Body does not match the contract; `error` names the fields. Do not retry unchanged |
| 401 | `{ "ok": false, "error" }` | Missing, bad or stale signature |
| 409 | `{ "ok": false, "eventId", "error": "Conflicting record for this eventId" }` | A row with this ID exists but is not this event (for example the same user already reported under the other account type). Nothing written; needs investigation, not a resend |
| 500 | `{ "ok": false, "error" }` | No secret configured, a database error, or (`"recorded": true`) recorded but not queued |

- `queued: true` means the deliveries were handed to QStash. That hand-off is a no-op when
  `QSTASH_TOKEN` or `PUBLIC_BASE_URL` is unset, so `queued` does not prove a worker will run.
  `queued: false` means every delivery was written as `SKIPPED` (or none, for staff bookings).
- **Resends.** Recording is deduplicated by `eventId`: when an event of this type with this
  `eventId` already exists, the resend writes nothing and answers `deduped: true`. Its
  deliveries are queued again (`requeued: true`) only if the event is more than 10 minutes old
  and still has a delivery that is `PENDING` with no attempts, which repairs a request that
  recorded the event but failed to queue it. Within those 10 minutes the first request's queue
  message may still be on its way, and requeuing then could deliver twice. A Google Ads
  delivery waiting for a too-recent retry (see below) has been attempted, so it is not
  requeued.
- Staff events add `"skippedOutbound": true` and a `skipReason` (`opus_staff_booking` or
  `opus_staff_account`).

## What gets recorded

One transaction writes:

- `InboundWebhook` with `source = "opus"`, `action = "trial.booked"`, `externalId = eventId`.
- `Appointment` with `id = eventId`, `status = "scheduled"`, the contact fields,
  `datetime = booking.startsAt`, `gclid`/`ttclid` from the snapshot, `vaAttrib` = the known
  ingest token (linking the visitor's visit history, as on an Acuity appointment) or else
  `eventId` (linking the snapshot), and
  `scheduledBy = "opus:staff"` for staff bookings.
- `Attribution` with `token = eventId`: a snapshot taken at booking time.
  - With a known `vaAttrib` whose ingest row was last touched no later than 10 minutes after
    `occurredAt`, each of the UTMs, click IDs (`gclid`, `gbraid`, `wbraid`, `dclid`,
    `fbclid`, `ttclid`, `msclkid`), `fbp`, `fbc`, `ttp`, `hubspotutk`, first and last URL,
    referrer and touch time, `visitorId` and `sessionId` comes from the ingest row; the event's
    `attribution` fills only the fields the ingest row lacks.
  - Without one, every field comes from the event's `attribution` (including `fbp`, `fbc`,
    `ttp` and `hubspotutk`), touch times default to `occurredAt`, and `dclid`, `visitorId` and
    `sessionId` are null.
  - `ipAddress` and `userAgent` always come from `client` (the booking request).
- `CanonicalEvent` `TRIAL_BOOKED` with `eventTime = occurredAt` and `value = valueCents / 100`.
- `Delivery` rows for `GOOGLE_ADS`, `HUBSPOT` and `META` only. A platform not listed in
  `OPUS_DELIVERY_PLATFORMS` is written as `SKIPPED`, so Opus deliveries start switched off.

A booking writes only to tables and columns that existed before accounts and page events
were added, and its delivery reads only those. It works on a database that does not have the
`EventContact` table or the new event names yet.

An account writes the same rows with these differences:

- `InboundWebhook` has `action` = the event's `type`.
- No `Appointment`. The dashboard and HubSpot delivery read an appointment as a booking, so
  the contact fields go to an `EventContact` row instead, with `vaAttrib` = the known ingest
  token (or null) and `staffInitiated`.
- The `Attribution` snapshot (`token = eventId`) is the idempotency key.
- `CanonicalEvent` is `ACCOUNT_CREATED` or `TEACHER_ACCOUNT_CREATED` with no `appointmentId`,
  and `value` from `EVENT_VALUES` or none.
- `Delivery` rows for `GOOGLE_ADS` and `META` only; Opus already writes the contact to HubSpot.
  An account with no ad click ID, no email and no phone gets both rows `SKIPPED`: no platform
  could match it.

## Delivery

The existing QStash worker sends the deliveries.

- **Google Ads:** uploads to the action mapped as `opus:TRIAL_BOOKED` in
  `GOOGLE_ADS_CONVERSION_ACTIONS`. Production:
  `TRIAL_BOOKED=7447834932,opus:TRIAL_BOOKED=7889634403`, where 7889634403 is "Attrib - Opus
  Trial Lesson Scheduled" (created 2026-11-04 as a secondary action with the Acuity action's
  settings). Opus events never fall back to the Acuity action; without the mapping the delivery
  is `SKIPPED`.
- **Meta:** sends one Conversions API event to the `META_PIXEL_ID` dataset, the one Acuity
  bookings go to.
  - **Which bookings.** Every reported booking, as for Google Ads and HubSpot, whether or not
    `vaAttrib` links it to a visit. A family often books in another browser than the one that
    clicked the ad (Meta ads open in Instagram's and Facebook's built-in browsers), and the
    booker's hashed email and phone are then all Meta has to match the booking to that click.
    So a booking that has nothing to do with a Virtu.Academy page, for example a Forte
    teacher's own student, also reaches Virtu.Academy's Meta dataset.
  - **Event name.** The one mapped as `opus:TRIAL_BOOKED` in `META_CAPI_EVENT_NAMES`, for
    example `TRIAL_BOOKED=<Acuity's name>,opus:TRIAL_BOOKED=Purchase`. Opus events never fall
    back to Acuity's name, `META_CAPI_EVENT_NAME` or a built-in default; without the entry the
    delivery is `SKIPPED`. Entries with a `source:` prefix are ignored when Acuity's names are
    resolved.
  - **What the event means.** Booked, not paid. A booking is reported whether or not the card
    was charged (`invoicePaid`), and `value` is the trial's price before any discount code or
    account credit. Weigh that when the name is `Purchase`. Meta lists `value` and `currency`
    as required for `Purchase`; its documentation does not say what it does with one that has
    no value (`valueCents` is `null`).
  - **What is sent.** `event_id` = `eventId`, `event_time` = `occurredAt`, `action_source` =
    `website`, `event_source_url` = the visit's last page address without its query string or
    fragment (without a linked visit: the landing page Opus captured, or `https://virtu.academy`
    when it captured none), `value` and `currency`, the SHA-256 hashes of the booker's email, phone and first
    and last name, an IP address and user agent (see "IP address" below), the snapshot's `fbc`
    and `fbp`, and the hash of `eventId` as `external_id`. Custom data: `appointment_id`
    (the `eventId`), `appointment_type_id` (`null` for Opus) and the visit's `utm_source`,
    `utm_medium` and `utm_campaign`. `data_processing_options` is empty unless
    `META_CAPI_LDU_ENABLED` is on. If the name is `StartTrial` and `META_CAPI_PREDICTED_LTV`
    is set, `predicted_ltv` is added. The `fbp` is usually the `_fbp` cookie Opus read at
    booking, because the page sets none. No Meta pixel or Meta cookie is involved on the page.
  - A failed Meta delivery does not ask for a retry, as for Acuity. It is tried again whenever
    the same queue message is delivered again, for whatever reason.
  - With `OUTBOUND_MODE=mock`, a `PENDING` row is marked `SUCCESS` without the name being
    checked or Meta being called.
  - `META_CAPI_TEST_EVENT_CODE` applies to every Meta event of both booking systems. Meta
    does not drop such events: its documentation says they "flow into Events Manager and are
    used for targeting and ads measurement purposes". Leave it empty in production.
- **Accounts:** delivered like a booking, with these differences.
  - **Google Ads:** the actions mapped as `opus:ACCOUNT_CREATED` and
    `opus:TEACHER_ACCOUNT_CREATED` in `GOOGLE_ADS_CONVERSION_ACTIONS`. Without its entry an
    event is `SKIPPED`; it never lands in the booking action or any other.
  - **Meta:** the names mapped as `opus:ACCOUNT_CREATED` (suggested `CompleteRegistration`) and
    `opus:TEACHER_ACCOUNT_CREATED` (a custom name, for example `TeacherRegistration`, since
    Meta has one standard registration event) in `META_CAPI_EVENT_NAMES`. Without its entry
    an event is `SKIPPED`; there is no fallback name. Custom data carries only the visit's
    `utm_source`, `utm_medium` and `utm_campaign`.
  - **Every reported account,** from any page, linked to a visit or not, whatever the visitor
    chose in Termly. Opus decides which signups it reports.
  - **HubSpot:** nothing.
  - The mapping entries are the per-event switch: with `GOOGLE_ADS` or `META` already listed
    in `OPUS_DELIVERY_PLATFORMS` for bookings, an account event is still `SKIPPED` there until
    its own entry exists.
- **Consent (v1):** like Acuity uploads, Opus uploads mark `adUserData` and `adPersonalization`
  as granted. As on virtu.academy, the marketing site's page-view capture (`/api/attrib/ingest`)
  and Opus's own click capture run whatever the visitor chose in Termly, and so do the Google
  upload and the Meta event. The HubSpot tracking script loads only after Termly consent, so
  `hubspotutk` (and the `utk` sent to HubSpot) exists only for visitors who accepted. Gating the
  capture, the Google upload and the Meta event on Termly advertising consent is planned for
  v2, on both sites at once.
- **No Meta cookie on lessons.virtu.academy:** that page (the paid-ads trial page) shows the
  Termly banner. So for a request whose `Origin` is `https://lessons.virtu.academy`,
  `/api/attrib/ingest` does not invent `_fbp` and sets neither `_fbp` nor `_fbc`. It still
  stores Meta IDs the visitor already has, and an `fbc` built from `fbclid` when the visitor
  has none; the stored `fbc` is the click ID a delivered booking carries to Meta. A visitor
  who already has a `_fbc` cookie from an earlier ad click on virtu.academy keeps that older
  value, even when arriving from a new click. Other virtu.academy pages are unchanged. Meta's
  cookies return there with consent-gated Meta tracking (v2).
- **HubSpot:** sends the same `HUBSPOT_EVENT_NAMES` event as Acuity, with
  `source_system = "opus"`, and the snapshot's `hubspotutk` as `utk` when it has one: the
  linked ingest row's, or else the cookie Opus read at booking. Acuity events keep
  `HUBSPOT_SOURCE_SYSTEM`.
- **IP address:** a linked booking's snapshot carries the ingest row's `sessionId` (its latest
  session), so the worker sends that session's first IP and user agent, as for Acuity. An
  unlinked booking sends the booking request's, which also fills in either value the session
  lacks.
- `GOOGLE_ADS_VALIDATE_ONLY=true` uploads are recorded as `SKIPPED`, not `SUCCESS`, for both
  booking systems: Google checks them but records nothing.
- An Opus event is only ever delivered to a platform that is `GOOGLE_ADS`, `HUBSPOT` or `META`
  and is listed in `OPUS_DELIVERY_PLATFORMS` when the worker runs; any other delivery row is
  marked `SKIPPED` without calling the platform.
- `va_attrib` values shaped like `opus_…` or `page_…` (the tokens of recorded events) are never
  accepted from a browser: ingest replaces a cookie that is not one of its UUID tokens, and the
  Acuity webhook ignores such an intake value.

### Google Ads: an upload called too recent

Every Google Ads upload goes at once, for every source (Acuity, Opus, page events). Google's
reference says an upload is refused while its click (`TOO_RECENT_EVENT`) or a newly created
conversion action (`TOO_RECENT_CONVERSION_ACTION`) is under six hours old, "Retry after 6
hours have passed". Production has not shown that refusal (21 uploads accepted and none
refused between 2026-11-07 and 2026-11-20), so nothing is delayed up front. Only an upload
Google actually refuses this way is tried again later:

- **When.** Google's answer consists of those two codes and nothing else. Any other error
  beside them is a plain failure, as before.
- **What happens.** The delivery stays `PENDING`. Its `responseBody` starts with the marker
  `TOO_RECENT_RETRY n/4`, `attempts` goes up by one, `lastAttemptAt` is set, and one queue
  message is scheduled 6 hours 15 minutes later. No new column carries any of this.
- **The later message names the platform** (`{ "canonicalEventId", "platform": "GOOGLE_ADS" }`)
  and a run for it touches only that event's Google Ads deliveries. An ordinary message tries
  every `FAILED` delivery of the event again, and a HubSpot event has no idempotency key. No
  other platform name and no other field is accepted.
- **Until it is due,** any other run for the event (a queue retry for another platform, a
  resend) leaves the waiting delivery alone, so it cannot use up the retries. "Due" is 6 hours
  10 minutes after `lastAttemptAt`: five minutes less than the delay, so the delivery's own
  message never comes too early by this server's clock.
- **At most four retries.** If Google still calls the fourth too recent, the delivery is
  `FAILED`. The count survives other failures: a delivery that fails for another reason in
  between (an outage, a rate limit, a thrown error) keeps `TOO_RECENT_RETRY n/4 used.` at the
  start of its `responseBody`, and so does one that failed at the limit, so a later run cannot
  start a new round.
- **If the later message cannot be queued,** the delivery is `FAILED` with that reason and an
  error is logged.
- **The queue is not asked to retry** the message that got the answer: the worker answers 200.
- A lost later message leaves that one delivery `PENDING` for good. Nothing sweeps it.
- A retried Acuity upload reads the visit as it is at retry time, as an immediate upload
  does. Opus and page events keep a frozen copy of the visit.
- A `CLICK_NOT_FOUND` answer still counts as `SUCCESS`, as before.

### Rollout

A delivery recorded as `SKIPPED` (its platform was off in `OPUS_DELIVERY_PLATFORMS`, Google
ran in validate-only mode, or Meta had no `opus:TRIAL_BOOKED` name) is never delivered later,
even after the setting changes. Turn each platform on, and validate-only off, before the
bookings you want delivered. A booking recorded before this service knew `META` as an Opus
platform has no `META` row and is never sent.

For Meta, in this order:

1. Deploy the version that knows `META` as an Opus platform, with no setting changed.
2. Add the `opus:TRIAL_BOOKED` entry to `META_CAPI_EVENT_NAMES`, keeping every entry already
   there, and add `META` to `OPUS_DELIVERY_PLATFORMS`, in the same change. Redeploy.

Never give an older version an `opus:` entry: there every entry counts as a mapping, so Acuity
events that rely on the built-in names stop being sent. And never run with `META` on and no
`opus:TRIAL_BOOKED` name: the worker records each qualifying booking as `SKIPPED`.

For accounts:

1. Bring the database up to date (`npx prisma migrate deploy`) before this version deploys.
   Accounts and page events need the new event names and the `EventContact` table. If the
   version deploys first, only those new events fail (answered 500, nothing written, so a
   resend records them later); bookings are recorded and delivered as before.
2. Create the two Google Ads conversion actions at least six hours before the first event
   (a too-recent action costs retries), then add `opus:ACCOUNT_CREATED=<id>` and
   `opus:TEACHER_ACCOUNT_CREATED=<id>` to `GOOGLE_ADS_CONVERSION_ACTIONS`, and the two names to
   `META_CAPI_EVENT_NAMES`, keeping every entry already there.
3. An account recorded before its entry exists is `SKIPPED` and never delivered later.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPUS_WEBHOOK_SECRET` | attrib | Shared HMAC secret. The endpoint answers 500 without it. |
| `OPUS_DELIVERY_PLATFORMS` | attrib | Comma list of `GOOGLE_ADS`, `HUBSPOT`, `META`. Empty means record only. |
| `GOOGLE_ADS_CONVERSION_ACTIONS` | attrib | Add `opus:TRIAL_BOOKED=7889634403`, and `opus:ACCOUNT_CREATED=<id>` and `opus:TEACHER_ACCOUNT_CREATED=<id>` for accounts. |
| `META_CAPI_EVENT_NAMES` | attrib | Add `opus:TRIAL_BOOKED=<Meta event name>`, and `opus:ACCOUNT_CREATED=<name>` and `opus:TEACHER_ACCOUNT_CREATED=<name>` for accounts. An event with no entry is not sent to Meta. |
| `EVENT_VALUES` | attrib | Optional USD values for events that carry none: `opus:ACCOUNT_CREATED=15,opus:TEACHER_ACCOUNT_CREATED=15`. Without an entry no value is sent. |
| `ATTRIB_WEBHOOK_URL` | Opus | Full endpoint URL. Opus sends nothing without it. |
| `ATTRIB_WEBHOOK_SECRET` | Opus | Same value as `OPUS_WEBHOOK_SECRET`. |
