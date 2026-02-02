# TikTok Ads API Integration Plan

## Overview

This plan outlines completing the TikTok Events API integration to mirror how the Google Ads integration works. The existing stub at `src/lib/outbound/tiktok.ts` needs to be expanded into a full implementation.

---

## TikTok Events API Reference

### API Endpoint
```
POST https://business-api.tiktok.com/open_api/v1.3/event/track/
```

### Request Format
*(Verified from [tiktok/gtm-template-eapi](https://github.com/tiktok/gtm-template-eapi) - TikTok's official GTM template)*

```json
{
  "event_source": "web",
  "event_source_id": "<PIXEL_CODE>",
  "partner_name": "VirtuAnalytics",
  "test_event_code": "<optional_for_testing>",
  "data": [
    {
      "event": "SubmitForm",
      "event_time": 1687758765,
      "event_id": "unique-event-id",
      "user": {
        "ttclid": "click-id-from-url",
        "ttp": "tiktok-pixel-cookie",
        "external_id": "hashed-external-id",
        "email": "hashed-email",
        "phone": "hashed-phone",
        "ip": "123.456.789.1",
        "user_agent": "Mozilla/5.0..."
      },
      "page": {
        "url": "https://virtu.academy/schedule",
        "referrer": "https://tiktok.com"
      },
      "properties": {
        "currency": "USD",
        "value": 0
      }
    }
  ]
}
```

### Authentication
- **Header**: `Access-Token: <access_token>`
- **Header**: `Content-Type: application/json`

### Event Name Mapping (Matching Google Ads Pattern)

| CanonicalEventName    | TikTok Event      | Notes                                    |
|-----------------------|-------------------|------------------------------------------|
| `TRIAL_BOOKED`        | `SubmitForm`      | Lead/form submission for trial booking   |
| `TRIAL_RESCHEDULED`   | `SubmitForm`      | Treated as form resubmission             |
| `TRIAL_CANCELED`      | (skip)            | No TikTok event for cancellations        |
| `APPOINTMENT_UPDATED` | `Schedule`        | Regular appointment scheduling           |

**Alternative mapping option**: Use `CompleteRegistration` for trials if optimizing for registrations.

### Hashing Requirements (SHA256)
Fields that **MUST** be hashed before sending:
- `email` - lowercase, trim, SHA256
- `phone` - digits only (with country code), SHA256
- `external_id` - SHA256
- (Optional) `first_name`, `last_name`, `zip_code` - lowercase, trim, SHA256

Fields that should **NOT** be hashed:
- `ttclid` - sent as-is
- `ip` - sent as-is
- `user_agent` - sent as-is
- `event_id` - sent as-is

### Deduplication
TikTok deduplicates events using `event_id` within a 5-minute window. The same `event_id` sent via Pixel and Events API will be merged.

---

## Implementation Steps

### Step 1: Environment Variables

Add to `.env` and documentation:

```env
# TikTok Events API
TIKTOK_PIXEL_ID=                    # Required: Pixel ID (event_source_id)
TIKTOK_ACCESS_TOKEN=                # Required: Events API access token
TIKTOK_TEST_EVENT_CODE=             # Optional: For testing in Events Manager
TIKTOK_DEFAULT_PHONE_COUNTRY_CODE=1 # Optional: Default country code for phones
TIKTOK_EVENT_ACTIONS=TRIAL_BOOKED=SubmitForm,TRIAL_RESCHEDULED=SubmitForm,APPOINTMENT_UPDATED=Schedule
                                    # Optional: Custom event name mapping
```

**How to get credentials:**
1. Go to TikTok Ads Manager → Tools → Events
2. Select your Pixel → Settings
3. Click "Generate Access Token"

---

### Step 2: Update `src/lib/outbound/tiktok.ts`

Replace the stub with a full implementation following the Google Ads pattern.

#### 2.1 Type Definitions

```typescript
type TikTokEventArgs = {
  eventId: string;
  eventName?: string | null;      // CanonicalEventName
  eventTime: Date;
  conversionValue?: number | null;
  currencyCode?: string | null;

  // Click ID
  ttclid?: string | null;

  // User identifiers (will be hashed)
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;     // e.g., va_attrib token

  // Context (not hashed)
  userIpAddress?: string | null;
  userAgent?: string | null;

  // Page data
  pageUrl?: string | null;
  pageReferrer?: string | null;
};

type TikTokSendResult =
  | { skipped: true; reason: string; requestBody: string }
  | { skipped: false; ok: boolean; status: number; body: string; requestBody: string };
```

#### 2.2 Core Functions to Implement

```typescript
// 1. Hash functions (reuse existing sha256Hex from crypto.ts)
function hashForTikTok(value: string): string;
function hashEmail(email: string | null): string | null;
function hashPhone(phone: string | null, defaultCountryCode: string | null): string | null;

// 2. Event name mapping
function resolveTikTokEventName(canonicalName: string | null): string | null;

// 3. Build auth check
function buildTikTokAuth(): { ok: true; pixelId: string; accessToken: string }
                          | { ok: false; reason: string };

// 4. Build request payload
function buildTikTokEventPayload(args: TikTokEventArgs): object;

// 5. Main send function
export async function sendTikTokEvent(args: TikTokEventArgs): Promise<TikTokSendResult>;
```

#### 2.3 Full Implementation Structure

```typescript
import { sha256Hex } from "../crypto";

const TIKTOK_API_ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

// ... type definitions ...

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase();
}

function hashForTikTok(value: string): string {
  return sha256Hex(normalizeForHash(value));
}

function hashEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return null;
  return hashForTikTok(normalized);
}

function hashPhone(phone?: string | null, defaultCountryCode?: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D+/g, "");
  if (!digits) return null;

  // Add country code if not present and phone doesn't start with country code
  if (defaultCountryCode && digits.length <= 10) {
    digits = defaultCountryCode.replace(/\D+/g, "") + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return hashForTikTok(digits);
}

function parseEventMapping(value?: string | null): Record<string, string> {
  if (!value) return {};
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [eventName, tiktokEvent] = pair.split("=").map(p => p.trim());
    if (eventName && tiktokEvent) map[eventName] = tiktokEvent;
  }
  return map;
}

function resolveTikTokEventName(canonicalName?: string | null): string | null {
  const mapping = parseEventMapping(process.env.TIKTOK_EVENT_ACTIONS);

  // Use custom mapping if defined
  if (canonicalName && mapping[canonicalName]) {
    return mapping[canonicalName];
  }

  // Default mapping
  const defaults: Record<string, string> = {
    TRIAL_BOOKED: "SubmitForm",
    TRIAL_RESCHEDULED: "SubmitForm",
    APPOINTMENT_UPDATED: "Schedule"
  };

  if (canonicalName && defaults[canonicalName]) {
    return defaults[canonicalName];
  }

  return null; // TRIAL_CANCELED and unknown events are skipped
}

function buildTikTokAuth(): { ok: true; pixelId: string; accessToken: string } | { ok: false; reason: string } {
  const pixelId = process.env.TIKTOK_PIXEL_ID;
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    const missing: string[] = [];
    if (!pixelId) missing.push("TIKTOK_PIXEL_ID");
    if (!accessToken) missing.push("TIKTOK_ACCESS_TOKEN");
    return { ok: false, reason: `Missing env: ${missing.join(", ")}` };
  }

  return { ok: true, pixelId, accessToken };
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export async function sendTikTokEvent(args: TikTokEventArgs): Promise<TikTokSendResult> {
  // 1. Check mock mode
  if (process.env.OUTBOUND_MODE === "mock") {
    return { skipped: true, reason: "TIKTOK mock mode", requestBody: JSON.stringify(args) };
  }

  // 2. Verify auth
  const authResult = buildTikTokAuth();
  if (!authResult.ok) {
    return { skipped: true, reason: authResult.reason, requestBody: JSON.stringify(args) };
  }

  // 3. Resolve event name (skip if no mapping)
  const tiktokEventName = resolveTikTokEventName(args.eventName);
  if (!tiktokEventName) {
    return {
      skipped: true,
      reason: `No TikTok event mapping for: ${args.eventName}`,
      requestBody: JSON.stringify(args)
    };
  }

  // 4. Check for identifiers (need ttclid OR hashed user data)
  const defaultCountryCode = process.env.TIKTOK_DEFAULT_PHONE_COUNTRY_CODE ?? null;
  const hashedEmail = hashEmail(args.email);
  const hashedPhone = hashPhone(args.phone, defaultCountryCode);
  const ttclid = args.ttclid?.trim() || null;

  if (!ttclid && !hashedEmail && !hashedPhone) {
    return {
      skipped: true,
      reason: "Missing ttclid and user identifiers (email/phone)",
      requestBody: JSON.stringify(args)
    };
  }

  // 5. Build user object
  const user: Record<string, string> = {};
  if (ttclid) user.ttclid = ttclid;
  if (hashedEmail) user.email = hashedEmail;
  if (hashedPhone) user.phone = hashedPhone;
  if (args.externalId) user.external_id = hashForTikTok(args.externalId);
  if (args.userIpAddress) user.ip = args.userIpAddress;
  if (args.userAgent) user.user_agent = args.userAgent;

  // 6. Build event data
  const eventData: Record<string, unknown> = {
    event: tiktokEventName,
    event_time: toUnixSeconds(args.eventTime),
    event_id: args.eventId,
    user
  };

  // Add page data if available
  if (args.pageUrl || args.pageReferrer) {
    eventData.page = {
      ...(args.pageUrl && { url: args.pageUrl }),
      ...(args.pageReferrer && { referrer: args.pageReferrer })
    };
  }

  // Add properties if value is set
  if (args.conversionValue != null && Number.isFinite(args.conversionValue)) {
    eventData.properties = {
      value: args.conversionValue,
      currency: args.currencyCode || "USD"
    };
  }

  // 7. Build full request
  const request: Record<string, unknown> = {
    event_source: "web",
    event_source_id: authResult.pixelId,
    partner_name: "VirtuAnalytics",
    data: [eventData]
  };

  // Add test event code if configured
  const testEventCode = process.env.TIKTOK_TEST_EVENT_CODE;
  if (testEventCode) {
    request.test_event_code = testEventCode;
  }

  const requestBody = JSON.stringify(request);

  // 8. Send request
  try {
    const res = await fetch(TIKTOK_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": authResult.accessToken
      },
      body: requestBody,
      cache: "no-store"
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    // TikTok returns { code: 0, message: "OK" } on success
    const responseCode = parsed && typeof parsed === "object" ? (parsed as { code?: number }).code : null;
    const ok = res.ok && responseCode === 0;
    const body = parsed ? JSON.stringify(parsed) : text;

    return { skipped: false, ok, status: res.status, body, requestBody };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { skipped: false, ok: false, status: 500, body: message, requestBody };
  }
}
```

---

### Step 3: Update Delivery Route

Update `src/app/api/qstash/deliver/route.ts` to pass all required arguments to `sendTikTokEvent`:

```typescript
// Current (lines 186-192):
if (d.platform === "TIKTOK") {
  const r = await sendTikTokEvent({
    eventId: ce.eventId,
    ttclid: appt?.ttclid ?? attrib?.ttclid ?? null
  });
  await mark({ status: r.skipped ? "SKIPPED" : "FAILED", responseBody: r.reason, requestBody: r.requestBody });
}

// Updated:
if (d.platform === "TIKTOK") {
  if (mockOutbound) {
    await mark({ status: "SUCCESS", responseBody: "mock_tiktok" });
  } else {
    const r = await sendTikTokEvent({
      eventId: ce.eventId,
      eventName: ce.name,
      eventTime: ce.eventTime,
      conversionValue: ce.value ?? null,
      currencyCode: ce.currency ?? null,
      ttclid: appt?.ttclid ?? attrib?.ttclid ?? null,
      email,
      phone,
      externalId: ce.attributionTok ?? null,
      userIpAddress: ip,
      userAgent: userAgent,
      pageUrl: eventSourceUrl,
      pageReferrer: attrib?.lastReferrer ?? null
    });

    if (r.skipped) {
      await mark({ status: "SKIPPED", responseBody: r.reason, requestBody: r.requestBody });
    } else {
      await mark({
        status: r.ok ? "SUCCESS" : "FAILED",
        responseCode: r.status,
        responseBody: r.body,
        requestBody: r.requestBody
      });
    }
  }
}
```

---

### Step 4: Create Test Endpoint

Create `src/app/api/test/tiktok/route.ts` mirroring the Google Ads test endpoint:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { sendTikTokEvent } from "@/lib/outbound/tiktok";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const expected = `Bearer ${process.env.TIKTOK_TEST_SECRET}`;

  if (!process.env.TIKTOK_TEST_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const result = await sendTikTokEvent({
    eventId: body.eventId ?? `test-${Date.now()}`,
    eventName: body.eventName ?? "TRIAL_BOOKED",
    eventTime: body.eventTime ? new Date(body.eventTime) : new Date(),
    conversionValue: body.conversionValue ?? null,
    currencyCode: body.currencyCode ?? null,
    ttclid: body.ttclid ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null,
    externalId: body.externalId ?? null,
    userIpAddress: body.userIpAddress ?? null,
    userAgent: body.userAgent ?? null,
    pageUrl: body.pageUrl ?? null,
    pageReferrer: body.pageReferrer ?? null
  });

  return NextResponse.json(result);
}
```

**Add to `.env`:**
```env
TIKTOK_TEST_SECRET=your-test-secret-here
```

---

### Step 5: Update Environment Documentation

Add TikTok environment variables to any README or documentation:

```markdown
### TikTok Events API

| Variable | Required | Description |
|----------|----------|-------------|
| `TIKTOK_PIXEL_ID` | Yes | Your TikTok Pixel ID (event_source_id) |
| `TIKTOK_ACCESS_TOKEN` | Yes | Events API access token from Ads Manager |
| `TIKTOK_TEST_EVENT_CODE` | No | Test event code for debugging |
| `TIKTOK_DEFAULT_PHONE_COUNTRY_CODE` | No | Default country code (e.g., "1" for US) |
| `TIKTOK_EVENT_ACTIONS` | No | Custom event mapping (e.g., "TRIAL_BOOKED=SubmitForm") |
| `TIKTOK_TEST_SECRET` | No | Secret for /api/test/tiktok endpoint |
```

---

## Implementation Checklist

- [ ] **Step 1**: Add TikTok environment variables
- [ ] **Step 2**: Implement full `src/lib/outbound/tiktok.ts`
  - [ ] Type definitions
  - [ ] Hash functions (email, phone, external_id)
  - [ ] Auth validation
  - [ ] Event name mapping
  - [ ] Request building
  - [ ] API call with error handling
  - [ ] Response parsing (check for `code: 0`)
- [ ] **Step 3**: Update delivery route to pass all args
  - [ ] Add mock mode support
  - [ ] Pass email, phone, IP, user agent
  - [ ] Pass page URL and referrer
  - [ ] Update status marking logic
- [ ] **Step 4**: Create test endpoint at `/api/test/tiktok`
- [ ] **Step 5**: Update documentation
- [ ] **Step 6**: Test with TikTok's Test Events tool
- [ ] **Step 7**: Verify events appear in TikTok Events Manager

---

## Feature Parity Matrix

| Feature | Google Ads | TikTok (Target) |
|---------|-----------|-----------------|
| Auth validation | ✓ `buildAuth()` | ✓ `buildTikTokAuth()` |
| Missing env handling | ✓ Returns skipped | ✓ Returns skipped |
| Mock mode support | ✓ OUTBOUND_MODE=mock | ✓ OUTBOUND_MODE=mock |
| Event name mapping | ✓ GOOGLE_ADS_CONVERSION_ACTIONS | ✓ TIKTOK_EVENT_ACTIONS |
| Email hashing | ✓ SHA256 + Gmail normalization | ✓ SHA256 |
| Phone hashing | ✓ E.164 + SHA256 | ✓ Digits + country code + SHA256 |
| Click ID support | ✓ gclid/gbraid/wbraid | ✓ ttclid |
| Skip if no identifiers | ✓ | ✓ |
| Request body logging | ✓ | ✓ |
| Response body logging | ✓ | ✓ |
| Partial failure handling | ✓ CLICK_NOT_FOUND | ✓ Check `code: 0` |
| Test endpoint | ✓ /api/test/google-ads | ✓ /api/test/tiktok |
| Conversion value | ✓ | ✓ |
| IP address | ✓ | ✓ |
| User agent | ✗ | ✓ |
| Page URL | ✗ | ✓ |
| Page referrer | ✗ | ✓ |

---

## Event Flow Diagram

```
Acuity Webhook
     │
     ▼
Create CanonicalEvent
     │
     ├─► name: TRIAL_BOOKED / TRIAL_RESCHEDULED / APPOINTMENT_UPDATED
     │
     ▼
Create Delivery (platform: TIKTOK)
     │
     ▼
QStash Queue
     │
     ▼
/api/qstash/deliver
     │
     ▼
sendTikTokEvent()
     │
     ├─► Check auth (TIKTOK_PIXEL_ID, TIKTOK_ACCESS_TOKEN)
     ├─► Map event name (TRIAL_BOOKED → SubmitForm)
     ├─► Check identifiers (ttclid OR email/phone)
     ├─► Hash PII (email, phone, external_id)
     ├─► Build request JSON
     ├─► POST to TikTok API
     │
     ▼
Store in Delivery
     │
     ├─► requestBody: JSON sent to TikTok
     ├─► responseBody: JSON received from TikTok
     ├─► responseCode: HTTP status
     └─► status: SUCCESS / FAILED / SKIPPED
```

---

## Testing Guide

### 1. Unit Testing with Test Event Code

Set `TIKTOK_TEST_EVENT_CODE` to a value from TikTok's Events Manager test tool. Events sent with this code will appear in the test events section without affecting production data.

### 2. Manual Testing via API

```bash
curl -X POST https://analytics.virtu.academy/api/test/tiktok \
  -H "Authorization: Bearer YOUR_TEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-123",
    "eventName": "TRIAL_BOOKED",
    "eventTime": "2026-01-10T12:00:00Z",
    "ttclid": "your-ttclid-here",
    "email": "test@example.com",
    "phone": "+14155551234",
    "pageUrl": "https://virtu.academy/schedule"
  }'
```

### 3. Verify in TikTok Events Manager

1. Go to TikTok Ads Manager → Tools → Events
2. Select your Pixel
3. Check "Test Events" tab for test events
4. Check "Overview" for production events

---

## Error Handling

### Common TikTok API Response Codes

| Code | Message | Handling |
|------|---------|----------|
| 0 | OK | Success |
| 40000 | Invalid parameter | Check request format |
| 40001 | Invalid access token | Regenerate token |
| 40002 | Rate limit exceeded | Implement backoff |
| 40100 | Pixel ID not found | Verify TIKTOK_PIXEL_ID |

### Skip Conditions (mark as SKIPPED)

1. Missing `TIKTOK_PIXEL_ID` or `TIKTOK_ACCESS_TOKEN`
2. Event name maps to null (e.g., `TRIAL_CANCELED`)
3. No ttclid AND no email AND no phone
4. `OUTBOUND_MODE=mock`

---

## Sources

### Primary Sources (Verified - Content Successfully Fetched)

| Source | Type | What Was Extracted |
|--------|------|-------------------|
| [tiktok/gtm-template-eapi](https://github.com/tiktok/gtm-template-eapi) | **Official TikTok repo** | Complete request structure, event mapping, hashing logic, `partner_name` field |
| [tiktok/tiktok-business-api-sdk](https://github.com/tiktok/tiktok-business-api-sdk) | **Official TikTok SDK** | Base URL, endpoint patterns, API version v1.3 |
| [stape-io/tiktok-tag](https://github.com/stape-io/tiktok-tag) | Third-party GTM tag | Implementation reference, user data fields, cookie handling |
| [VictorValar/python-tiktok-events-api](https://github.com/VictorValar/python-tiktok-events-api) | Third-party Python lib | Schema structure, Pydantic models |

### Secondary Sources (Referenced but not directly fetched - 403 errors)

- [TikTok Events API Overview](https://ads.tiktok.com/help/article/events-api) - Official docs (blocked)
- [TikTok Standard Events](https://ads.tiktok.com/help/article/standard-events-parameters) - Official docs (blocked)
- [TikTok Marketing API Docs](https://ads.tiktok.com/marketing_api/docs?id=1741601162187777) - Official API reference (blocked)
