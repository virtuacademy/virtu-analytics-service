# Virtu Analytics v1

## TODO:
- check that only initial schedules are counted (not reschedules). 
- Add support for trial vs regular bookings (all track). 
- Google ads: set new vs. old customer data for conversions. 
- Session data for google ads conversion stuff
- Add cart-data
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
Testing:
- `POST /api/test/google-ads` - manual Google Ads upload using `sendGoogleAdsClickConversion` (requires `GOOGLE_ADS_TEST_SECRET`).

Dashboard:
- `GET /` - dashboard UI (requires login if `AUTH_PASSWORD` is set)
- `GET /login` - login screen that sets the auth cookie

## Environment variables

See `.env.example` for the full list. Key values:
- `DATABASE_URL` - Postgres connection string
- `PUBLIC_BASE_URL` - e.g. `https://analytics.virtu.academy`
- `ALLOWED_ORIGINS` - comma-separated Webflow origins
- `COOKIE_DOMAIN` - `.virtu.academy`
- Acuity: `ACUITY_USER_ID`, `ACUITY_API_KEY`, field ids, trial appointment type id, `ACUITY_WEBHOOK_FORWARD_URL` (optional)
- QStash: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`
- HubSpot: `HUBSPOT_PORTAL_ID`, `HUBSPOT_TRIAL_FORM_GUID`, `HUBSPOT_PRIVATE_APP_TOKEN`
- Google Ads: `GOOGLE_ADS_DEVELOPER_TOKEN`, OAuth creds, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_ID(S)`, `GOOGLE_ADS_AD_USER_DATA_CONSENT`, `GOOGLE_ADS_CONVERSION_TIMEZONE(_OFFSET)`, default phone country
- Optional: `OUTBOUND_MODE=mock` (skip outbound calls and mark deliveries as success)
- Optional: `AUTH_PASSWORD` (protects the dashboard; login at `/login`)

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
  const ACUITY_OWNER_ID = "XXXXXX";
  const GA_MEASUREMENT_ID = "G-2GJPZWGDSH";

  const fieldMap = {
    va_attrib: "field:17785670",
    utm_source: "field:7449269",
    utm_medium: "field:7449270",
    utm_term: "field:7449271",
    utm_campaign: "field:7449272",
    gclid: "field:7449277",
    fbclid: "field:9386123",
    awc: "field:10292912",
    ua: "field:9386202",
    sref_id: "sref_id",
    sscid: "sscid"
  };

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

  function getParamOrCookie(name, days) {
    const param = getParam(name);
    if (param) {
      setCookie(name, param, days);
      return param;
    }
    return readCookie(name);
  }

  function getGAIds(timeoutMs) {
    return new Promise(resolve => {
      if (typeof window.gtag !== "function") {
        resolve({ clientId: null, sessionId: null });
        return;
      }
      let clientId = null;
      let sessionId = null;
      let gotClient = false;
      let gotSession = false;
      const finish = () => resolve({ clientId, sessionId });
      const timer = setTimeout(finish, timeoutMs);

      window.gtag("get", GA_MEASUREMENT_ID, "client_id", id => {
        clientId = id || null;
        gotClient = true;
        if (gotSession) {
          clearTimeout(timer);
          finish();
        }
      });
      window.gtag("get", GA_MEASUREMENT_ID, "session_id", id => {
        sessionId = id || null;
        gotSession = true;
        if (gotClient) {
          clearTimeout(timer);
          finish();
        }
      });
    });
  }

  async function buildEmbed() {
    const url = new URL("https://app.acuityscheduling.com/schedule.php");
    url.searchParams.set("owner", ACUITY_OWNER_ID);

    Object.keys(fieldMap).forEach(key => {
      const value = getParamOrCookie(key, 7);
      if (value) url.searchParams.set(fieldMap[key], value);
    });

    const ga = await getGAIds(1200);
    if (ga.clientId) url.searchParams.set("clientId", ga.clientId);
    if (ga.sessionId) url.searchParams.set("sessionId", ga.sessionId);

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
- `va_attrib` is a readable cookie so it can be passed into the iframe.
- `va_vid` and `va_sid` are httpOnly and stay server-only.
- The numeric `field:*` IDs must match the Acuity intake field IDs you configured (and should align with `ACUITY_FIELD_*` in env for the backend).
- If you do not need GA client/session IDs, remove the `gtag` bits and keep the rest.
- If you do not want Acuity's auto-resizing behavior, remove the `embed.js` injection block.

## Acuity setup

1) Create intake fields for the trial appointment type:
- `va_attrib` (text)
- optional: `utm_source`, `utm_medium`, `utm_term`, `utm_campaign`
- optional: `gclid`, `fbclid`, `awc`, `ua`
- optional: `sref_id`, `sscid` (if you want to pass these through directly)
- optional: `ttclid`, `fbp`, `fbc` (only if you extend the script)
- optional: `va_vid`, `va_sid` (debug)

2) Hide the fields using Acuity CSS or keep them in an optional "Additional info" step.

3) Create a single webhook subscription using `action = changed`:
- Webhook URL: `https://analytics.virtu.academy/api/webhooks/acuity`
- Signature is HMAC-SHA256 base64 over the raw request body using `ACUITY_API_KEY`.

4) Record field IDs and appointment type ID in environment variables:
- `ACUITY_FIELD_VA_ATTRIB_ID`, `ACUITY_FIELD_GCLID_ID`, ...
- `ACUITY_TRIAL_APPOINTMENT_TYPE_IDS` (comma-separated)

## Delivery behavior (Meta, Google Ads, TikTok, HubSpot)

If `OUTBOUND_MODE=mock`, Meta and HubSpot deliveries are marked success without external calls.

Meta CAPI:
- `event_id` is the Acuity appointment id for dedupe with Pixel.
- User data includes hashed email/phone plus IP + user agent (if captured from ingest).
- `fbc` and `fbp` are used when present.

Google Ads:
- Uses `UploadClickConversions` (enhanced conversions for leads).
- Sends `gclid` / `gbraid` / `wbraid` when present plus hashed email/phone/name identifiers.
- Sets `order_id`, `conversion_date_time` (configured timezone), and `partial_failure=true`.
- Conversion action mapping uses `GOOGLE_ADS_CONVERSION_ACTIONS` (comma-separated `EVENT=ID`) with `GOOGLE_ADS_CONVERSION_ACTION_ID` fallback.
- Populates consent when configured; skips uploads with no click IDs and no user identifiers.

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



node scripts/google-ads-test-upload.mjs \
    --gclid="PASTE_GCLID" \
    --email="ben@virtu.academy" \
    --phone="+13147692365" \
    --value=0 \
    --currency=USD \
    --debug=true \
    --validate-only=true