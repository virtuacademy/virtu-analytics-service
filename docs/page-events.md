# Page events → attrib

A marketing page reports here what a visitor did on it, so Google Ads and Meta can count it and
bid on it. Today there is one event: a callback request on the paid-ads trial page
(lessons.virtu.academy/trial), sent after HubSpot has accepted the callback form.

Owners: this service owns the endpoint and the contract; the trial page (`apps/virtu` in the
fortelessons.com repo) is the only sender. Change both sides together.

## Request

`POST /api/attrib/event` with `content-type: application/json`, from an origin listed in
`ALLOWED_ORIGINS`. Send it without credentials; no cookie of this service is read.

```json
{
  "type": "callback.requested",
  "attribTok": "0b6c5a1e-3f4d-4c2b-9a8e-7d6f5e4c3b2a",
  "contact": { "email": "parent@example.com", "phone": "(555) 555-0123", "firstName": "Pat" }
}
```

- `type` is `callback.requested`. Nothing else is accepted.
- `attribTok` is the visit token the page already holds: the `va_attrib` value that
  `/api/attrib/ingest` returned for this visitor. It must be the UUID of a visit this service
  recorded.
- `contact` is what the visitor typed into the callback form. Every field may be `null`, blank
  or left out, and so may `contact` itself. Limits: `email` 254 characters, `phone` 40,
  `firstName` 100. Send them as typed; this service normalizes and hashes them for each
  platform.
- The whole body may be at most 2048 characters. Unknown fields are ignored.

The call is best effort. Send it after the form succeeded, do not wait for it, and never show
the visitor its outcome.

## Response

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "ok": true }` | Recorded. Also the answer for a duplicate (see below) |
| 400 | `{ "ok": false, "error" }` | Not JSON, or a body outside the contract |
| 403 | `{ "ok": false, "error" }` | The `Origin` header is missing or not in `ALLOWED_ORIGINS` |
| 404 | `{ "ok": false, "error" }` | No visit has this token |
| 413 | `{ "ok": false, "error" }` | Body over 2048 characters |
| 500 | `{ "ok": false, "error" }` | Database error |

An answer never repeats anything the caller sent and carries no ID.

## Rules that keep it from minting conversions

The endpoint is public: anyone can post to it, and a script can send any `Origin` header. So:

- **A real visit.** The token must name a visit recorded by `/api/attrib/ingest`. Tokens of
  other events (`opus_…`, `page_…`) are not UUIDs and are refused.
- **One per visit per 24 hours.** A second `callback.requested` for the same token within 24
  hours of an earlier one is recorded with every delivery `SKIPPED` as a duplicate and is never
  delivered. Requests for one token are taken in turn (a row lock on the visit), so two posts at
  the same moment cannot both count. Any earlier event counts, a duplicate included, so repeated
  posts keep the window open.
- **Something to match.** An event whose visit has no ad click ID and that carries neither an
  email nor a phone number is recorded and never delivered.
- **Only a browser on a listed site.** A request whose `Origin` is not in `ALLOWED_ORIGINS` is
  refused. This stops other websites, not scripts.

What remains possible: someone who loads the page gets a real token and can post one made-up
callback for it per day. Google Ads counts it only if it matches one of the account's ad
clicks, by click ID or by the hashed email or phone. The HubSpot form the event sits beside is
just as public. There is no per-IP rate limit, and every request, duplicates included, writes
rows.

## What gets recorded

One transaction writes:

- `Attribution` with `token = eventId` (`page_callback_<uuid>`): the visit's ingest row copied
  as it stands, so later page views cannot change this conversion.
- `CanonicalEvent` `CALLBACK_REQUESTED` with `eventTime` = now, no `appointmentId`,
  `attributionTok = eventId`, and `value` from `EVENT_VALUES` (`page:CALLBACK_REQUESTED=<USD>`)
  or none.
- `EventContact` with the contact fields and `vaAttrib` = the visit token. No `Appointment`
  is written: the dashboard and HubSpot delivery would read one as a booking.
- `Delivery` rows for `GOOGLE_ADS` and `META` only. HubSpot gets nothing from here; the form
  already wrote the contact.

## Delivery

The QStash worker sends the deliveries, as for bookings (see
[opus-trial-webhook.md](opus-trial-webhook.md#delivery)), with the source `page`:

- **Switch.** `PAGE_DELIVERY_PLATFORMS` lists the platforms page events are delivered to
  (`GOOGLE_ADS`, `META`). Empty or unset records events without delivering them. A delivery
  recorded as `SKIPPED` is never delivered later, and the worker also skips a platform that is
  off when it runs. `OPUS_DELIVERY_PLATFORMS` does not apply.
- **Google Ads:** uploads to the action mapped as `page:CALLBACK_REQUESTED` in
  `GOOGLE_ADS_CONVERSION_ACTIONS`, with the visit's `gclid` and the hashed email and phone.
  Without the entry the delivery is `SKIPPED`; it never falls back to another action. The
  upload waits until the click is old enough (see "Google Ads hold" in
  [opus-trial-webhook.md](opus-trial-webhook.md#google-ads-hold)).
- **Meta:** sends the event named by `page:CALLBACK_REQUESTED` in `META_CAPI_EVENT_NAMES`
  (suggested `Lead`). Without the entry the delivery is `SKIPPED`; there is no fallback name.
  It carries the visit's `fbc` (built from `fbclid` at ingest), the hashed email, phone and
  first name, the visit session's IP address and user agent, and the page address without its
  query string or fragment. It is sent whatever the visitor chose in the Termly banner, like
  an Opus booking (see "Consent (v1)" in opus-trial-webhook.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `ALLOWED_ORIGINS` | Must list the page's origin (`https://lessons.virtu.academy`). |
| `PAGE_DELIVERY_PLATFORMS` | Comma list of `GOOGLE_ADS`, `META`. Empty means record only. |
| `GOOGLE_ADS_CONVERSION_ACTIONS` | Add `page:CALLBACK_REQUESTED=<action id>`. |
| `META_CAPI_EVENT_NAMES` | Add `page:CALLBACK_REQUESTED=<Meta event name>`. |
| `EVENT_VALUES` | Optional `page:CALLBACK_REQUESTED=<USD amount>`. Without it no value is sent. |
