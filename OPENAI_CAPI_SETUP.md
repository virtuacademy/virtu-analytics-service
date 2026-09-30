# ChatGPT Ads conversion setup for Virtu

Verified against official documentation on September 30, 2026. This adds ChatGPT to the existing Acuity → canonical event → QStash → outbound delivery pipeline. It does not manage campaigns or spending.

## Correct API and credentials

OpenAI's [Conversions API](https://developers.openai.com/ads/conversions-api) accepts server-side events at `https://bzr.openai.com/v1/events?pid=<PIXEL-ID>`, with a Conversions API key in the bearer header. Get the Pixel ID and **Conversions API key** from Ads Manager's conversions tab. The [Advertiser API](https://developers.openai.com/ads/api-overview) and general model API use different credentials and are not needed for this adapter.

The saved Conversions API key and Pixel ID passed a synthetic validation request on September 30, 2026 (HTTP 200, `validate_only: true`). This verifies access to conversion ingestion. Attribution and production delivery still need a genuine-event check after deployment. If conversion setup is unavailable, request it through Ads Manager/OpenAI support or your partner representative. Some [partner provisioning endpoints](https://developers.openai.com/ads/api-partner-setup) require separate account enablement; this setup uses credentials created by the account owner in Ads Manager.

## Human steps

1. Sign in to [Ads Manager](https://ads.openai.com/) and select the **Virtu** account. Open **Conversions**, create/select its web data source, and obtain its Pixel ID and Conversions API key. Keep both associated with the same intended account. Complete any required account verification.
2. In a local editor, add the values to this app's ignored `.env.local` or existing `.env`. Never paste the key into chat, source code, a ticket, or a shell command. Never use a `NEXT_PUBLIC_` prefix.

   ```dotenv
   OPENAI_CAPI_API_KEY="<Conversions API key>"
   OPENAI_CAPI_PIXEL_ID="<Pixel ID>"
   OPENAI_CAPI_ENABLED="false"
   OPENAI_CAPI_VALIDATE_ONLY="true"
   OPENAI_CAPI_EVENTS="TRIAL_BOOKED"
   OPENAI_CAPI_DEFAULT_PHONE_COUNTRY_CODE=""
   ```

   Run `chmod 600 .env` (or `.env.local`, whichever you edited). All `.env*` files remain ignored except the blank/example-only `.env.example`. The CLI loads Next.js development env files; process env and `.env.local` can override `.env`. Remove stale duplicate CAPI values.

3. Run `npm run openai-capi:validate`. It always sends a fresh **synthetic** booking with `validate_only: true`, even if the env is configured for live delivery. It uses no database or real customer records. A successful HTTP result verifies request acceptance, not ad attribution. [Validation-only events are not saved and do not appear in event monitoring](https://developers.openai.com/ads/conversion-tracking#2-send-an-event).
4. Review the desired event selection. The default is trial bookings only. Configure the corresponding `appointment_scheduled` conversion event in Ads Manager for the selected source; do not change an existing live campaign's goal as part of setup. Account/pixel configuration may require a human action in Ads Manager. See [conversion setup](https://developers.openai.com/ads/api-reference/conversion-setup).
5. Before production activation, confirm the existing measurement permissions cover OpenAI and provision the CAPI settings in the deployment's server-side secret store. Apply the enum migration before deploying code that writes `OPENAI` deliveries. The owner has applied the production migration, and a read-only check verified its checksum and the `OPENAI` enum value. Application deployment is still pending.
6. To record genuine new conversions after setup, use `OPENAI_CAPI_ENABLED=true` and `OPENAI_CAPI_VALIDATE_ONLY=false`. An optional comma-separated `APPOINTMENT_BOOKED` adds regular lesson bookings. Set the phone country prefix only when applicable (e.g. `1` for US/Canada national ten-digit numbers); otherwise email/international phone matching is used.
7. After an authorized deployment, check one genuine new self-scheduled trial: an `OPENAI` delivery should reach `SUCCESS`, and the event should appear in Ads Manager. Check that staff bookings and later edits do not add conversions. Enabling measurement does not launch ads; campaign changes and spend still require explicit approval.

## Production walkthrough

Local credentials configure this computer only. The deployed service at `attrib.virtu.academy` also needs its own server-side environment variables.

1. In OpenAI Ads Manager's **Conversions** area for Virtu, confirm a conversion definition for `appointment_scheduled` uses the data source associated with the saved Pixel ID. A useful display name is **Virtu trial booked**. The documented conversion setting uses a 30-day click attribution window. Do not attach or change settings on a live campaign without explicit approval.
2. In Vercel, select the **fortelessons** team and **virtu-analytics-service** project. Open **Settings → Environment Variables** and add these to **Production**, using the existing local credentials for the first two values:

   | Variable                    | Initial value                             |
   | --------------------------- | ----------------------------------------- |
   | `OPENAI_CAPI_API_KEY`       | Saved Conversions API key; mark sensitive |
   | `OPENAI_CAPI_PIXEL_ID`      | Saved Pixel ID                            |
   | `OPENAI_CAPI_ENABLED`       | `false`                                   |
   | `OPENAI_CAPI_VALIDATE_ONLY` | `true`                                    |
   | `OPENAI_CAPI_EVENTS`        | `TRIAL_BOOKED`                            |

   These variables must remain server-side, without a `NEXT_PUBLIC_` prefix. Keep Preview delivery disabled. Leave the optional phone country prefix unset unless it is appropriate for the supplied national phone numbers. [Vercel environment-variable instructions](https://vercel.com/docs/environment-variables/managing-environment-variables).

3. Test the migration on a disposable PostgreSQL database, then apply the reviewed migration to production before deploying this branch through the existing release process. It adds `OPENAI` to the allowed delivery platforms; there are no new tables or columns. Production rollout requires the owner's authorization.
4. When ready for genuine conversion reporting, set `OPENAI_CAPI_ENABLED=true` and `OPENAI_CAPI_VALIDATE_ONLY=false` in Production and deploy with those values. Vercel environment changes take effect only in a new deployment. Check that the deployment is not using `OUTBOUND_MODE=mock` before activation; that setting affects the other providers too.
5. Verify the next genuine new self-scheduled trial has an `OPENAI` delivery marked `SUCCESS` and appears in Ads Manager event monitoring. Event receipt and attribution to an ad are separate checks. Do not create a fake live conversion to test this step.

Docker is optional. It was attempted only to run a disposable local PostgreSQL instance for migration testing. A separate hosted test database or another local PostgreSQL installation serves the same purpose. The production app continues to use Vercel and its existing PostgreSQL database; this integration does not require a new production database or Docker service.

## Behavior and limits

- `TRIAL_BOOKED` maps to `appointment_scheduled`, with `data.type=customer_action`. A booked trial does not prove a trial started or a purchase occurred. Reschedules, cancellations, and generic updates are not separate conversion types; no revenue value is sent. [Supported events](https://developers.openai.com/ads/supported-events).
- Acuity's `changed` webhook also fires on edits and reschedules. Existing canonical booking history is checked before creating the new event: subsequent observations are skipped for OpenAI, avoiding automatic historical backfills. The provider event ID `acuity_booking_<appointment ID>` stays stable across retries and concurrent first observations. This is prospective tracking; missing historical bookings are not reconstructed.
- Timestamps use the current service's canonical webhook-processing time. First observation can occur after the actual booking. The adapter rejects events older than seven days or more than ten minutes in the future instead of changing their timestamp. CAPI's documented deduplication uses pixel, event type, and event ID. [Event requirements](https://developers.openai.com/ads/conversions-api).
- Email normalization preserves dots and plus aliases. Phone normalization keeps the country code. Identifiers are SHA-256 hashed; existing IP/user agent can support matching. The source URL's query/fragment is removed. No browser pixel, cookie collection, `oppref`, or `__obref` flow is added; identifier matching may provide less attribution coverage than a consent-aware combined browser/server integration. No consent is inferred from the Google adapter's settings. `opt_out: true` applies to possible future personalization, not measurement permission.
- Missing configuration, disabled/mock mode, excluded event types, stale events, and successful validation-only requests are `SKIPPED`. Only successful HTTP responses in live mode are `SUCCESS`; this means accepted by CAPI, not matched to an ad or financially reconciled.
- HTTP 429/5xx or network failures are `FAILED` and return worker HTTP 503 so QStash can retry. Completed platform deliveries are skipped on retries. HTTP 4xx failures remain `FAILED` without an automatic retry loop; correct configuration and explicitly requeue if appropriate and still within the event window. No replay/reset tool was added.
- Logs and saved delivery diagnostics contain HTTP status, validation mode, timestamp and identifier field names only. They omit keys, identifiers/hashes, full payloads, raw errors and upstream response bodies. The request uses a fixed HTTPS endpoint, a ten-second timeout, no cache, and rejects redirects.
- No customer data or conversion events are sent merely by adding the code, running unit tests, or building. The synthetic validation command is the only manual external test. Existing `OUTBOUND_MODE=mock` makes the normal adapter skip sending; the synthetic command intentionally overrides it to test API access.

## Migration and validation

The migration `prisma/migrations/20260930120000_add_openai_delivery/migration.sql` adds `OPENAI` to `DeliveryPlatform`. There are no new tables or columns. Regenerate Prisma with `npm run prisma:generate`. Validate migrations against a newly created disposable PostgreSQL database with an explicit `DATABASE_URL`; do not use the application's existing production `.env` for a development migration or reset. Production rollout should use reviewed `prisma migrate deploy` before app deployment.

```sh
npm run test:openai-capi
npm run typecheck -- --incremental false
npm run lint
npm run format:check
npm run build
```

Adapter tests mock the network. Pipeline tests run the real route code with mocked database/QStash boundaries, including staff exclusions, historical booking skips, status recording, retry responses, and isolation of completed platforms. The credentialed synthetic API check has passed. The complete migration sequence also passed on a disposable PostgreSQL 17.9 instance, matching the hosted database version; the temporary server has been stopped.

Work is on local branch `codex/openai-ads-setup`, based on verified Vercel production commit `0f512f2ce978afc4a00403b07a141df39970016f` (deployment `dpl_522ieMtNJ6i9g7ZAJN8ZE1qwjSds`, alias `attrib.virtu.academy`). This retains deployed staff-booking suppression. The original local `main` and its README commit remain intact. Nothing has been deployed or pushed.

### Apply the prepared migration

The local app's configured hosted database was inspected read-only on September 30, 2026 and confirmed to be the database used by Vercel Production. Its migration history matches the corrected local filenames and checksums. The owner has now applied the OpenAI migration. The commands below remain useful for other environments or later releases; verify each environment's connection and migration history separately.

From this app directory, with the intended database URL in the ignored `.env` file:

```sh
npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status
```

On an otherwise current environment that has not received this change, the first status check should list only `20260930120000_add_openai_delivery` as pending; Prisma exits with status 1 when migrations are pending. On the verified production database, this migration is already applied. After migration deployment, the final check should report that the schema is up to date. `migrate deploy` applies pending migration files and records them in Prisma's history. It does not deploy the application or activate OpenAI delivery. Use the production command above; this repository's `npm run prisma:migrate` runs the development command `prisma migrate dev` and should not be used on production. Do not reset the database or run the SQL manually outside migration tracking. See [Prisma's development and production guidance](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/development-and-production).

### Local verification results (September 30, 2026)

- 16 adapter/pipeline tests passed.
- TypeScript, ESLint, repository formatting check, and production build passed.
- Prisma client regenerated; schema validation passed. Prisma's database-free schema diff produced exactly the included enum alteration.
- SQL migration verification passed on a disposable PostgreSQL 17.9 instance without Docker: six baseline migrations applied, the OpenAI migration applied, an existing synthetic delivery stayed unchanged, an `OPENAI` delivery insert succeeded, a repeat deploy was a no-op, and the resulting schema matched Prisma. The temporary server was stopped. No production records were copied into the test database.
- A read-only check of the hosted database confirmed the six existing migration checksums match local files. Its last historical migration is recorded as `20260202222005_add_ttp`; commit `80e30f0` had subsequently renamed that folder to `20260202222005_add_appointment_booked`. The original folder name has been restored locally with identical SQL so Prisma does not try to reapply it. After correction, Prisma reported only `20260930120000_add_openai_delivery` as pending. The owner then applied it; a subsequent read-only check confirmed the migration checksum and the `OPENAI` enum value in the database used by Vercel Production.
- Credentialed synthetic validation passed: HTTP 200, `validate_only: true`, event type `appointment_scheduled`, one synthetic hashed-email identifier, at `2026-09-30T17:31:29.416Z`. The validation did not record a conversion. No customer records were used.
- The credential file `.env` remains ignored by Git and now has owner-only permissions (`0600`). No credentials were copied into documentation or logs.

### Production readiness check (September 30, 2026)

- Vercel Production uses the same database on which the OpenAI migration was verified.
- Production is configured with `OPENAI_CAPI_ENABLED=true`, `OPENAI_CAPI_VALIDATE_ONLY=false`, and `OPENAI_CAPI_EVENTS=TRIAL_BOOKED`; outbound mock mode is off. Deploying the updated code will therefore activate genuine trial-booking reporting.
- QStash credentials are present. OpenAI credentials are listed in Vercel; sensitive values are withheld from local export and cannot be compared with the locally validated values. No secret values were printed, and temporary configuration exports were deleted.
- The production application is still on commit `0f512f2`. Updated application deployment and a genuine-event check remain pending.
