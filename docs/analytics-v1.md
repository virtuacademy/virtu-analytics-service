# Virtu Analytics v1

## Overview

This service is the source of truth for attribution and conversions across Webflow + Acuity today and the Opus app later.

High-level flow:
1) Webflow loads on each page and calls `/api/attrib/ingest`.
2) The analytics app returns first-party cookies on `.virtu.academy` (host-only in dev):
   - `va_vid` visitor id (httpOnly, 90-day TTL)
   - `va_sid` session id (httpOnly, 30-day TTL; server resets if idle > 30 min)
   - `va_attrib` attribution token (readable by JS so Webflow can pass it into the Acuity iframe)
3) The scheduling page injects hidden intake fields into the Acuity scheduler URL, including `va_attrib`.
4) Acuity webhook (`changed`) calls `/api/webhooks/acuity`.
5) Analytics app fetches appointment details, joins intake fields, creates canonical events, and queues deliveries (if QStash is configured).
6) `/api/qstash/deliver` sends server-side events to Meta/Google/TikTok/HubSpot and logs delivery status.

## Current behavior (v1)

- Every non-deduped Acuity `changed` webhook creates a canonical event; duplicates are deduped by `(source, action, id, body hash)`.
- Trial appointment types (`ACUITY_TRIAL_APPOINTMENT_TYPE_IDS`) map to `TRIAL_*` events; non-trial `scheduled` actions map to `APPOINTMENT_BOOKED`; all other non-trial updates map to `APPOINTMENT_UPDATED`.
- `event_time` is when the webhook is processed (not the appointment datetime).
- `event_id` is the Acuity appointment id (shared across reschedules/cancellations).
- `value` is Acuity `amountPaid` (if present) and `currency` is `USD`.
- Deliveries are queued only when `QSTASH_TOKEN` is set; `/api/qstash/deliver` also requires the QStash signing keys.
- `_fbp` is synthesized and set as a first-party cookie when missing; `_fbc` is synthesized only when missing *and* `fbclid` is present (otherwise it remains unset).
- Google Ads consent is currently hard-coded to `GRANTED` for both `adUserData` and `adPersonalization` (env vars in `.env.example` are not read by the code yet).

## What data we capture and why

From the browser (Webflow ingest):
- URL + referrer
- UTMs
- Click IDs: `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `ttclid`, `msclkid`
- Platform cookies: `_fbp`, `_fbc`, `_ttp`, `hubspotutk`

From the request headers (ingest):
- IP address (from `x-forwarded-for` / `x-real-ip`)
- User agent

From Acuity appointment (intake fields mapped via env):
- Email, phone, first/last name
- `va_attrib`, `gclid`, `ttclid`, `fbp`, `fbc`
- `amountPaid` (used as conversion value when present)

Why this matters:
- Meta CAPI uses `event_id` for dedupe and improves match with hashed email/phone plus IP and user agent.
- Google Ads click conversions primarily use `gclid`/`gbraid`/`wbraid`; enhanced conversions can also use hashed email/phone (names are not used today).
- TikTok Events API can match on `ttclid`, `_ttp`, or hashed identifiers (email/phone/external id).

## Endpoints

Public (CORS-protected):
- `POST /api/attrib/ingest` (also supports `OPTIONS` preflight)

Internal (signed):
- `POST /api/webhooks/acuity` - verifies signature, fetches appointment, creates canonical events, queues deliveries.
- `POST /api/qstash/deliver` - verifies QStash signature and sends outbound deliveries.

Debug:
- `GET|POST /api/graphql` - Apollo GraphQL endpoint to inspect attribution and deliveries (no auth).

Testing:
- `POST /api/test/meta` - manual Meta CAPI upload (requires `META_CAPI_TEST_SECRET`).
- `POST /api/test/google-ads` - manual Google Ads upload (requires `GOOGLE_ADS_TEST_SECRET`).
- `POST /api/test/tiktok` - manual TikTok Events API upload (requires `TIKTOK_TEST_SECRET`).

Auth:
- `POST /api/auth` - login (sets `va_auth` cookie)
- `DELETE /api/auth` - logout

Dashboard:
- `GET /` - dashboard UI (requires login if `AUTH_PASSWORD` is set)
- `GET /login` - login screen

## Environment variables

See `.env.example` for the full list. Key values:
- `DATABASE_URL` - Postgres connection string
- `PUBLIC_BASE_URL` - e.g. `https://analytics.virtu.academy`
- `ALLOWED_ORIGINS` - comma-separated Webflow origins (CORS)
- `COOKIE_DOMAIN` - `.virtu.academy` (prod only; dev uses host-only cookies)
- Acuity: `ACUITY_USER_ID`, `ACUITY_API_KEY`, intake field IDs, `ACUITY_TRIAL_APPOINTMENT_TYPE_IDS` (comma-separated), `ACUITY_TRIAL_APPOINTMENT_TYPE_ID` (legacy fallback), `ACUITY_WEBHOOK_FORWARD_URL` (optional legacy forward)
- QStash: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_EVENT_NAME(S)`, optional `META_CAPI_TEST_EVENT_CODE`, `META_CAPI_API_VERSION`, `META_CAPI_LDU_ENABLED`, `META_CAPI_PREDICTED_LTV`, `META_CAPI_TEST_SECRET`
- HubSpot: `HUBSPOT_PRIVATE_APP_TOKEN`, `HUBSPOT_EVENT_NAMES`, optional `HUBSPOT_SOURCE_SYSTEM`
- Google Ads: `GOOGLE_ADS_DEVELOPER_TOKEN`, OAuth creds, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_ID(S)`, `GOOGLE_ADS_CONVERSION_ACTIONS` (per-event mapping), `GOOGLE_ADS_DEFAULT_PHONE_COUNTRY_CODE`, `GOOGLE_ADS_CONVERSION_TIMEZONE(_OFFSET)`, optional `GOOGLE_ADS_VALIDATE_ONLY`/`GOOGLE_ADS_JOB_ID`
- TikTok: `TIKTOK_PIXEL_ID`, `TIKTOK_ACCESS_TOKEN`, optional `TIKTOK_EVENT_ACTIONS`, `TIKTOK_TEST_EVENT_CODE`, `TIKTOK_DEFAULT_PHONE_COUNTRY_CODE`
- Optional: `META_CAPI_TEST_SECRET`, `GOOGLE_ADS_TEST_SECRET`, `HUBSPOT_TEST_SECRET`, `TIKTOK_TEST_SECRET` (test endpoints)
- Optional: `OUTBOUND_MODE=mock` (skip outbound calls and mark deliveries success; HubSpot still requires envs or is skipped)
- Optional: `AUTH_PASSWORD` (protects the dashboard; login at `/login`)

## Webflow setup (site-wide)

Add the ingest script in Site Settings (Head or Before Body End). This script:
- reads UTMs + click ids from the URL
- reads `_fbp`, `_fbc`, `_ttp`, and `hubspotutk` cookies if present
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
  click.ttp = getCookie("_ttp");

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

Notes:
- `ALLOWED_ORIGINS` must include the Webflow origin that calls this endpoint.
- `va_attrib` is a readable cookie so it can be passed into the iframe.
- `va_vid` and `va_sid` are httpOnly and stay server-only.

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
  const ACUITY_OWNER_ID = "XXXXXX";

  const fieldMap = [
    { key: "va_attrib", field: "field:17785670" },
    { key: "gclid", field: "field:7449277" },
    { key: "ttclid", field: "field:12345678" },
    { key: "fbp", field: "field:12345679", cookie: "_fbp" },
    { key: "fbc", field: "field:12345680", cookie: "_fbc" },
    // Optional (stored in Acuity but not used by the analytics service today):
    { key: "utm_source", field: "field:7449269" },
    { key: "utm_medium", field: "field:7449270" },
    { key: "utm_term", field: "field:7449271" },
    { key: "utm_campaign", field: "field:7449272" }
  ];

  function readCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days) {
    if (!value) return;
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = name + "=" + encodeURIComponent(value) + "; expires=" + date.toUTCString() + "; path=/";
  }

  function getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function getParamOrCookie(name, days, cookieName) {
    const param = getParam(name);
    if (param) {
      setCookie(name, param, days);
      return param;
    }
    return readCookie(cookieName || name);
  }

  async function buildEmbed() {
    const url = new URL("https://app.acuityscheduling.com/schedule.php");
    url.searchParams.set("owner", ACUITY_OWNER_ID);

    fieldMap.forEach(entry => {
      const value = getParamOrCookie(entry.key, 7, entry.cookie);
      if (value) url.searchParams.set(entry.field, value);
    });

    const iframe = document.createElement("iframe");
    iframe.src = url.toString();
    iframe.title = "Schedule Appointment";
    iframe.width = "100%";
    iframe.height = "900";
    iframe.style.border = "0";
    iframe.loading = "lazy";

    document.getElementById("acuity-embed").appendChild(iframe);

    const embedScript = document.createElement("script");
    embedScript.src = "https://embed.acuityscheduling.com/js/embed.js";
    embedScript.async = true;
    document.body.appendChild(embedScript);
  }

  window.addEventListener("message", function (event) {
    if (event.data === "appointmentScheduled") {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: "appointmentScheduled" });
    }
  });

  buildEmbed();
})();
</script>
```

Notes:
- The numeric `field:*` IDs must match the Acuity intake field IDs you configured (and should align with `ACUITY_FIELD_*` in env for the backend).
- The analytics service currently reads only `va_attrib`, `gclid`, `ttclid`, `fbp`, and `fbc` from Acuity; the UTM fields above are just for visibility in Acuity.
- If you do not want Acuity's auto-resizing behavior, remove the `embed.js` injection block.

## Acuity setup

1) Create intake fields for the appointment types you want to track:
- required: `va_attrib`
- optional: `gclid`, `ttclid`, `fbp`, `fbc`

2) Hide the fields using Acuity CSS or keep them in an optional "Additional info" step.

3) Create a single webhook subscription using `action = changed`:
- Webhook URL: `https://analytics.virtu.academy/api/webhooks/acuity`
- Signature is HMAC-SHA256 base64 over the raw request body using `ACUITY_API_KEY`.

4) Record field IDs and appointment type IDs in environment variables:
- `ACUITY_FIELD_VA_ATTRIB_ID`, `ACUITY_FIELD_GCLID_ID`, `ACUITY_FIELD_TTCLID_ID`, `ACUITY_FIELD_FBP_ID`, `ACUITY_FIELD_FBC_ID`
- `ACUITY_TRIAL_APPOINTMENT_TYPE_IDS` (comma-separated)
- Optional: `ACUITY_WEBHOOK_FORWARD_URL` to forward the raw webhook to a legacy endpoint

## Canonical events

- One canonical event is created per non-deduped webhook.
- `event_time` is the webhook processing time; `event_id` is the Acuity appointment id.
- Trial appointment types map to `TRIAL_BOOKED`, `TRIAL_RESCHEDULED`, `TRIAL_CANCELED`.
- Non-trial `scheduled` actions map to `APPOINTMENT_BOOKED`; other non-trial updates map to `APPOINTMENT_UPDATED`.
- `value` is set from Acuity `amountPaid` when available; `currency` is `USD`.
- A `Delivery` row is created for each platform (Meta, Google Ads, TikTok, HubSpot).

## Delivery behavior (Meta, Google Ads, TikTok, HubSpot)

General:
- If `OUTBOUND_MODE=mock`, Meta/Google/TikTok deliveries are marked `SUCCESS` without external calls; HubSpot still requires its env vars or the delivery is marked `SKIPPED`.
- If a platform is missing required env, the delivery is marked `SKIPPED` with a reason.
- Deliveries are retried by QStash (re-sending hits this endpoint).

Meta CAPI:
- `event_name` is resolved via `META_CAPI_EVENT_NAMES` (comma-separated `EVENT=Name`) with `META_CAPI_EVENT_NAME` as a fallback. If a mapping is set but does not include the canonical event (and no fallback is set), the delivery is skipped.
- Default event mapping (if no env mapping is provided): `TRIAL_BOOKED` -> `SubmitApplication`, `TRIAL_RESCHEDULED` -> `Schedule`, `TRIAL_CANCELED` -> `Cancel`, `APPOINTMENT_BOOKED`/`APPOINTMENT_UPDATED` -> `Schedule`, fallback `Lead`.
- `event_id` is the Acuity appointment id for dedupe.
- User data includes hashed email/phone plus IP + user agent (if captured from ingest).
- `fbc` and `fbp` are used when present (Acuity intake field takes precedence over ingest).

Google Ads:
- Uses `UploadClickConversions` (enhanced conversions for leads).
- Sends `gclid` / `gbraid` / `wbraid` when present plus hashed email/phone identifiers (names are not used today).
- Sets `order_id` to `eventId` unless provided (e.g. test endpoint override).
- Uses `amountPaid` as `conversion_value` when available; otherwise no value is sent.
- Sets `conversion_date_time` using `GOOGLE_ADS_CONVERSION_TIMEZONE` or `GOOGLE_ADS_CONVERSION_TIMEZONE_OFFSET`.
- Conversion action mapping uses `GOOGLE_ADS_CONVERSION_ACTIONS` (comma-separated `EVENT=ID`) with `GOOGLE_ADS_CONVERSION_ACTION_ID` fallback.
- Skips uploads with no click IDs and no user identifiers.

TikTok:
- Uses Events API v1.3 with default mapping:
  - `TRIAL_BOOKED` -> `StartTrial`
  - `TRIAL_RESCHEDULED` -> `SubmitForm`
  - `APPOINTMENT_UPDATED` -> `Schedule`
  - `TRIAL_CANCELED` and `APPOINTMENT_BOOKED` are skipped by default
- You can override mappings with `TIKTOK_EVENT_ACTIONS`.
- Sends `ttclid`/`_ttp` when present plus hashed email/phone/external id.

HubSpot:
- Uses the Custom Events API (Events v3 `send`) and maps canonical events via `HUBSPOT_EVENT_NAMES`.
- For TRIAL_BOOKED, sends `email` + `utk` when available to associate the event to a contact.
- Event properties: `event_id`, `source_system`, and default attribution fields like `hs_page_url`, `hs_referrer`, `hs_utm_source`, `hs_utm_medium`, `hs_utm_campaign`, `hs_utm_term`, `hs_utm_content`, `hs_user_agent`.

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

## Testing endpoints

- `POST /api/test/meta` (requires `META_CAPI_TEST_SECRET` via header or `?secret=...`)
- `POST /api/test/google-ads` (requires `GOOGLE_ADS_TEST_SECRET` via header or `?secret=...`)
- `POST /api/test/hubspot` (requires `HUBSPOT_TEST_SECRET` via header or `?secret=...`)
- `POST /api/test/tiktok` (requires `TIKTOK_TEST_SECRET` via header or `?secret=...`)

## How it all works together

- Webflow is responsible for capturing top-of-funnel data and calling `/api/attrib/ingest`.
- The analytics app issues durable IDs and attribution tokens as first-party cookies.
- The Acuity iframe receives the attribution token via hidden intake fields.
- The webhook provides the authoritative conversion moment.
- The analytics app joins webhook -> attribution -> deliveries and logs everything.
- Opus can reuse the same ingest + canonical event flow without iframe constraints.
