# Virtu Analytics Service

This is the analytics spine for Webflow + Acuity today and Opus later. It issues durable IDs, collects attribution, receives Acuity webhooks, and fans out server-side conversions.

## Quick start

1) Copy env vars:

```bash
cp .env.example .env.local
```

2) Fill in required values in `.env.local`.

3) Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

4) Run the dev server:

```bash
npm run dev
```

## Documentation

- Architecture, Webflow/Acuity setup, and data flow: `docs/analytics-v1.md`

## API endpoints

- `POST /api/attrib/ingest`
- `POST /api/webhooks/acuity`
- `POST /api/qstash/deliver`
- `POST /api/graphql`
