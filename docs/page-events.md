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
| 200 | `{ "ok": true }` | Recorded. Also the answer when the event is recorded but will not be delivered (see below) |
| 400 | `{ "ok": false, "error" }` | Not JSON, or a body outside the contract |
| 403 | `{ "ok": false, "error" }` | The `Origin` header is missing or not in `ALLOWED_ORIGINS` |
| 404 | `{ "ok": false, "error" }` | No visit has this token |
| 413 | `{ "ok": false, "error" }` | Body over 2048 characters |
| 500 | `{ "ok": false, "error" }` | Database error |

An answer never repeats anything the caller sent, carries no ID, and does not say whether the
event will be delivered.

## What bounds abuse

Nothing here can prove a person sent the request. Anyone can call the endpoint, a script can
send any `Origin` header, and anyone can get a visit token by loading the page. So the rules do
not try to tell people from scripts. They limit what one visit and one address can have
delivered, leave a record of every event that was refused, and raise an alarm when the day's
volume looks wrong.

An event is **recorded but delivered nowhere** (every delivery `SKIPPED` with the reason) when:

- **Duplicate.** The same visit already reported this event in the last 24 hours. Any earlier
  event counts, a refused one included, so repeated posts keep the window open.
- **Stale visit.** The visit was last seen more than 24 hours ago. A token harvested earlier
  stops working.
- **Nothing to match.** The visit has no ad click ID and the event carries neither an email nor
  a phone number.
- **Limit per address.** `PAGE_EVENT_DAILY_LIMIT_PER_IP` (default 3) events from the caller's
  address were already accepted for delivery in the last 24 hours. An IPv4 address counts by
  itself and an IPv6 address by its /64 network, since one IPv6 connection usually holds a whole
  /64 and could otherwise rotate through it. The address is taken as ingest takes it (first
  `X-Forwarded-For` entry, else `X-Real-IP`), so it is only as trustworthy as the proxy in front
  of this service. Requests with no address share one allowance.

Each of these is about the visit or the address that sent the event. **Nothing other visitors
do can refuse an event:** there is no limit shared by everyone, because a shared limit would
let a few forged requests a day stop every real callback, and a skipped delivery is never sent
later.

**The alarm.** When more than `PAGE_EVENT_DAILY_ALERT_THRESHOLD` (default 25) page events,
refused ones included, were recorded in the last 24 hours, every further one logs an error line
for monitoring to find, and is still delivered:
`[page-events] 26 page events in 24 hours, over PAGE_EVENT_DAILY_ALERT_THRESHOLD (25). Still
delivering. If this is a flood, remove the platforms from PAGE_DELIVERY_PLATFORMS.` Real volume
is a handful a week, so the line means either abuse or real volume that has outgrown the
setting.

**The brake.** To stop a flood, take the platforms out of `PAGE_DELIVERY_PLATFORMS` (empty
records events without delivering them). Events recorded while it is off are never delivered
later.

A request is **refused outright** (nothing written) when its token names no recorded visit
(tokens of other events, `opus_…` and `page_…`, are not UUIDs), its body is outside the
contract, or its `Origin` is not listed. The `Origin` check is not a protection: it only keeps
honest browsers on other sites out.

Page events are checked and recorded one at a time (a database lock held for the transaction),
so two requests at the same moment cannot both slip under a limit.

**What remains possible.** A script with many networks can forge callbacks, three a day from
each address, until someone switches page delivery off; the alarm line is how that gets
noticed. Each forged event carries whatever email the script typed, which goes to the ad
platforms hashed. Google Ads counts such an event only if it matches one of the account's ad
clicks. Every request that passes validation writes rows, refused events included, and there is
no limit on that.

## What gets recorded

One transaction writes:

- `Attribution` with `token = eventId` (`page_callback_<uuid>`): the visit's ingest row copied
  as it stands, so later page views cannot change this conversion.
- `CanonicalEvent` `CALLBACK_REQUESTED` with `eventTime` = now, no `appointmentId`,
  `attributionTok = eventId`, and `value` from `EVENT_VALUES` (`page:CALLBACK_REQUESTED=<USD>`)
  or none.
- `EventContact` with the contact fields, `vaAttrib` = the visit token and `ipAddress` = the
  caller's address. No `Appointment` is written: the dashboard and HubSpot delivery would read
  one as a booking.
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
| `PAGE_DELIVERY_PLATFORMS` | Comma list of `GOOGLE_ADS`, `META`. Empty means record only; this is also how to stop a flood. |
| `PAGE_EVENT_DAILY_LIMIT_PER_IP` | Page events delivered per 24 hours from one IPv4 address or IPv6 /64 network. Default 3; `0` delivers none. |
| `PAGE_EVENT_DAILY_ALERT_THRESHOLD` | Page events per 24 hours, from everyone, beyond which each one logs an error line. It never stops delivery. Default 25. |
| `GOOGLE_ADS_CONVERSION_ACTIONS` | Add `page:CALLBACK_REQUESTED=<action id>`. |
| `META_CAPI_EVENT_NAMES` | Add `page:CALLBACK_REQUESTED=<Meta event name>`. |
| `EVENT_VALUES` | Optional `page:CALLBACK_REQUESTED=<USD amount>`. Without it no value is sent. |
