# Virtu Analytics Service

Analytics and conversion tracking service for Virtu. Captures attribution from Webflow, joins it to Acuity appointments, and delivers server-side conversions to ad platforms.

## What it does

- Issues first-party visitor/session IDs and attribution tokens
- Captures UTMs, click IDs, and platform cookies (`_fbp`, `_fbc`, `_ttp`, `hubspotutk`)
- Processes Acuity "changed" webhooks into canonical events
- Sends conversions via QStash to Meta, Google Ads, HubSpot, and TikTok (skips platforms when required env/config is missing)
- Provides a small dashboard and GraphQL debug endpoint

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Copy env vars:

```bash
cp .env.example .env.local
```

3. Fill in required values in `.env.local`.

4. Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Run the dev server:

```bash
npm run dev
```

Open `http://localhost:3000` (if `AUTH_PASSWORD` is set, log in at `/login`).

## Configuration

Key env vars (see `.env.example` for the full list):

- Database: `DATABASE_URL`
- URLs/CORS/Cookies: `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `COOKIE_DOMAIN`
- Acuity: `ACUITY_USER_ID`, `ACUITY_API_KEY`, intake field IDs, appointment type IDs
- QStash: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_EVENT_NAME(S)`, optional `META_CAPI_TEST_EVENT_CODE`, `META_CAPI_API_VERSION`, `META_CAPI_LDU_ENABLED`, `META_CAPI_PREDICTED_LTV`
- HubSpot: `HUBSPOT_PRIVATE_APP_TOKEN`, `HUBSPOT_EVENT_NAMES`, optional `HUBSPOT_SOURCE_SYSTEM`
- Google Ads: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_ID(S)`, `GOOGLE_ADS_DEFAULT_PHONE_COUNTRY_CODE`, timezone settings, optional `GOOGLE_ADS_VALIDATE_ONLY`/`GOOGLE_ADS_JOB_ID`, consent settings (`GOOGLE_ADS_AD_USER_DATA_CONSENT`, `GOOGLE_ADS_AD_PERSONALIZATION_CONSENT`, currently ignored by code)
- TikTok: `TIKTOK_PIXEL_ID`, `TIKTOK_ACCESS_TOKEN`, optional `TIKTOK_EVENT_ACTIONS`, `TIKTOK_TEST_EVENT_CODE`, `TIKTOK_DEFAULT_PHONE_COUNTRY_CODE`
- Optional: `META_CAPI_TEST_SECRET`, `GOOGLE_ADS_TEST_SECRET`, `HUBSPOT_TEST_SECRET`, and `TIKTOK_TEST_SECRET` for test endpoints
- Optional: `OUTBOUND_MODE=mock` to skip real delivery, `AUTH_PASSWORD` to protect the dashboard

## API endpoints

- `POST /api/attrib/ingest`
- `POST /api/webhooks/acuity`
- `POST /api/qstash/deliver`
- `GET|POST /api/graphql` (debug; unauthenticated, returns PII)
- `POST /api/test/meta` (manual testing)
- `POST /api/test/google-ads` (manual testing)
- `POST /api/test/hubspot` (manual testing)
- `POST /api/test/tiktok` (manual testing)
- `POST /api/auth` (login), `DELETE /api/auth` (logout)

## Documentation

- Architecture, Webflow/Acuity setup, and data flow: `analytics-v1.md`

## Useful commands

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm run prisma:generate`
- `npm run prisma:migrate`
- `npm run prisma:studio`
