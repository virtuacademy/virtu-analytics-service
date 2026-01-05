# Virtu Analytics v1

## Overview

This service is the source of truth for attribution and conversions across Webflow + Acuity today and the Opus app later.

High-level flow:
1) Webflow loads on each page and calls `/api/attrib/ingest`.
2) The analytics app returns first-party cookies on `.virtu.academy`:
   - `va_vid` visitor id (httpOnly)
   - `va_sid` session id (httpOnly)
   - `va_attrib` attribution token (readable by JS so Webflow can pass it into the Acuity iframe)
3) The scheduling page injects hidden intake fields into the Acuity scheduler URL, including `va_attrib`.
4) Acuity webhook (`changed`) calls `/api/webhooks/acuity`.
5) Analytics app fetches appointment details, joins intake fields, creates canonical events, and queues deliveries.
6) `/api/qstash/deliver` sends server-side events to Meta/Google/TikTok/HubSpot and logs delivery status.

## What data we capture and why

From the browser (Webflow ingest):
- URL + referrer
- UTMs
- Click IDs: `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `ttclid`, `msclkid`
- Best-effort platform cookies: `_fbp`, `_fbc`, `hubspotutk`

From the request headers (ingest):
- IP address (from `x-forwarded-for` / `x-real-ip`)
- User agent

From Acuity appointment:
- Email, phone, first/last name
- Intake fields (va_attrib, gclid, ttclid, fbp, fbc)

Why this matters:
- Meta CAPI uses `event_id` for dedupe and improves match with hashed email/phone plus IP and user agent.
- Google Ads click conversions primarily use `gclid`/`gbraid`/`wbraid`; enhanced conversions can also use hashed email/phone.

## Endpoints

Public:
- `POST /api/attrib/ingest` - reads UTMs/click ids, creates/refreshes `va_vid`, `va_sid`, `va_attrib` cookies.

Internal:
- `POST /api/webhooks/acuity` - verifies signature, fetches appointment, creates canonical events, queues deliveries.

Queue worker:
- `POST /api/qstash/deliver` - verifies QStash signature and sends outbound deliveries.

Debug:
- `POST /api/graphql` - Apollo GraphQL endpoint to inspect attribution and deliveries.

## Environment variables

See `.env.example` for the full list. Key values:
- `DATABASE_URL` - Postgres connection string
- `PUBLIC_BASE_URL` - e.g. `https://analytics.virtu.academy`
- `ALLOWED_ORIGINS` - comma-separated Webflow origins
- `COOKIE_DOMAIN` - `.virtu.academy`
- Acuity: `ACUITY_USER_ID`, `ACUITY_API_KEY`, field ids, trial appointment type id
- QStash: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`
- HubSpot: `HUBSPOT_PORTAL_ID`, `HUBSPOT_TRIAL_FORM_GUID`, `HUBSPOT_PRIVATE_APP_TOKEN`

## Webflow setup (site-wide)

Add the ingest script in Site Settings (Head or Before Body End). This script:
- reads UTMs + click ids from the URL
- reads `_fbp`, `_fbc`, and `hubspotutk` cookies if present
- posts to `/api/attrib/ingest` with `credentials: "include"`

```html
<script>
(function () {
  const ENDPOINT = "https://analytics.virtu.academy/api/attrib/ingest";

  function qp(name) {
    const u = new URL(location.href);
    return u.searchParams.get(name);
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const utm = {
    utm_source: qp("utm_source"),
    utm_medium: qp("utm_medium"),
    utm_campaign: qp("utm_campaign"),
    utm_term: qp("utm_term"),
    utm_content: qp("utm_content")
  };

  const click = {
    gclid: qp("gclid"),
    gbraid: qp("gbraid"),
    wbraid: qp("wbraid"),
    dclid: qp("dclid"),
    fbclid: qp("fbclid"),
    ttclid: qp("ttclid"),
    msclkid: qp("msclkid")
  };

  click.fbp = getCookie("_fbp");
  click.fbc = getCookie("_fbc");

  const hubspotutk = getCookie("hubspotutk");

  fetch(ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: location.href,
      referrer: document.referrer || null,
      utm,
      click,
      hubspotutk
    })
  }).catch(() => {});
})();
</script>
```

## Webflow scheduling page (Acuity embed)

The Acuity iframe cannot read cookies because it is on `*.as.me`, so we pass the attribution token through intake fields.

1) Create a container in Webflow:

```html
<div id="acuity-embed"></div>
```

2) Add an embed script on the scheduling page that injects hidden intake fields:

```html
<script>
(function () {
  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const va_attrib = readCookie("va_attrib") || "";
  const fbp = readCookie("_fbp") || "";
  const fbc = readCookie("_fbc") || "";

  const base = "https://virtu.as.me/schedule.php?owner=XXXXXX";

  const F_VA = 111;
  const F_GCLID = 112;
  const F_TTCLID = 113;
  const F_FBP = 114;
  const F_FBC = 115;

  const u = new URL(base);
  u.searchParams.set("field:" + F_VA, va_attrib);
  if (fbp) u.searchParams.set("field:" + F_FBP, fbp);
  if (fbc) u.searchParams.set("field:" + F_FBC, fbc);

  const iframe = document.createElement("iframe");
  iframe.src = u.toString();
  iframe.width = "100%";
  iframe.height = "900";
  iframe.style.border = "0";
  iframe.loading = "lazy";

  document.getElementById("acuity-embed").appendChild(iframe);
})();
</script>
```

Notes:
- `va_attrib` is a readable cookie so it can be passed into the iframe.
- `va_vid` and `va_sid` are httpOnly and stay server-only.

## Acuity setup

1) Create intake fields for the trial appointment type:
- `va_attrib` (text)
- `gclid` (text)
- `ttclid` (text)
- `_fbp` (text)
- `_fbc` (text)
- optional: `va_vid`, `va_sid` (debug)

2) Hide the fields using Acuity CSS or keep them in an optional "Additional info" step.

3) Create a single webhook subscription using `action = changed`:
- Webhook URL: `https://analytics.virtu.academy/api/webhooks/acuity`
- Signature is HMAC-SHA256 base64 over the raw request body using `ACUITY_API_KEY`.

4) Record field IDs and appointment type ID in environment variables:
- `ACUITY_FIELD_VA_ATTRIB_ID`, `ACUITY_FIELD_GCLID_ID`, ...
- `ACUITY_TRIAL_APPOINTMENT_TYPE_ID`

## Delivery behavior (Meta, Google Ads, TikTok, HubSpot)

Meta CAPI:
- `event_id` is the Acuity appointment id for dedupe with Pixel.
- User data includes hashed email/phone plus IP + user agent (if captured from ingest).
- `fbc` and `fbp` are used when present.

Google Ads:
- v1 is stubbed. The intention is to use `UploadClickConversions` with:
  - `gclid` / `gbraid` / `wbraid`
  - enhanced conversions user identifiers (hashed email/phone, name)
- IP and user agent are not required for click conversions but can be used in enhanced conversion flows depending on the integration approach.

TikTok:
- v1 is stubbed. Use Events API with event id for dedupe once implemented.

HubSpot:
- Uses the authenticated "secure submit" endpoint with UTMs and click ids.

## GraphQL debug queries

Example query:

```graphql
query ($appointmentId: ID!) {
  appointment(id: $appointmentId) {
    id
    email
    vaAttrib
  }
  canonicalEventsByAppointment(appointmentId: $appointmentId) {
    id
    name
    eventId
    deliveries {
      platform
      status
      responseCode
    }
  }
}
```

## How it all works together

- Webflow is responsible for capturing top-of-funnel data and calling `/api/attrib/ingest`.
- The analytics app issues durable IDs and attribution tokens as first-party cookies.
- The Acuity iframe receives the attribution token via hidden intake fields.
- The webhook provides the authoritative conversion moment.
- The analytics app joins webhook -> attribution -> deliveries and logs everything.
- Opus can reuse the same ingest + canonical event flow without iframe constraints.
