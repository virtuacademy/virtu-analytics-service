# Virtu Analytics Service

Analytics and conversion tracking service for Virtu. Captures attribution from Webflow, joins it to Acuity appointments, and delivers server-side conversions to ad platforms.

## What it does
- Issues first-party visitor/session IDs and attribution tokens
- Captures UTMs, click IDs, and platform cookies
- Processes Acuity "changed" webhooks into canonical events
- Sends conversions via QStash to Meta and HubSpot (Google Ads and TikTok are stubbed)
- Provides a small dashboard and GraphQL debug endpoint

## Quick start
1) Install dependencies:

```bash
npm install
```

2) Copy env vars:

```bash
cp .env.example .env.local
```

3) Fill in required values in `.env.local`.

4) Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5) Run the dev server:

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
- Outbound: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID`, `HUBSPOT_TRIAL_FORM_GUID`, `HUBSPOT_PRIVATE_APP_TOKEN`
- Optional: `OUTBOUND_MODE=mock` to skip real delivery, `AUTH_PASSWORD` to protect the dashboard

## API endpoints
- `POST /api/attrib/ingest`
- `POST /api/webhooks/acuity`
- `POST /api/qstash/deliver`
- `POST /api/graphql`

## Documentation
- Architecture, Webflow/Acuity setup, and data flow: `docs/analytics-v1.md`

## Useful commands
- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run prisma:generate`
- `npm run prisma:migrate`
- `npm run prisma:studio`
