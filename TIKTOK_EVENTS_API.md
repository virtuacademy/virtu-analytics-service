# TikTok Events API Integration

This document describes the TikTok Events API integration in Virtu Analytics Service.

## Overview

The TikTok integration sends conversion events (trial bookings, appointments) to TikTok's Events API for attribution tracking. It mirrors the Google Ads integration pattern for consistency across the codebase.

## Architecture Comparison

| Component | Google Ads | TikTok |
|-----------|-----------|--------|
| Service file | `src/lib/outbound/googleAds.ts` | `src/lib/outbound/tiktok.ts` |
| Main function | `sendGoogleAdsClickConversion()` | `sendTikTokEvent()` |
| Test endpoint | `/api/test/google-ads` | `/api/test/tiktok` |
| Click ID | `gclid`, `gbraid`, `wbraid` | `ttclid`, `ttp` |
| Auth method | OAuth 2.0 (token refresh) | Static access token |
| API endpoint | `googleads.googleapis.com/v22/...` | `business-api.tiktok.com/open_api/v1.3/event/track/` |

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `TIKTOK_PIXEL_ID` | Your TikTok Pixel ID (event_source_id) | `CXXXXXXXXXXXXXXXXX` |
| `TIKTOK_ACCESS_TOKEN` | Events API access token | `abc123...` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `TIKTOK_TEST_EVENT_CODE` | Test event code for debugging | (none) |
| `TIKTOK_DEFAULT_PHONE_COUNTRY_CODE` | Default country code for phone normalization | `1` (US) |
| `TIKTOK_EVENT_ACTIONS` | Custom event name mapping | See below |
| `TIKTOK_TEST_SECRET` | Secret for `/api/test/tiktok` endpoint | (none) |

### Getting Credentials

1. Go to **TikTok Ads Manager** → **Tools** → **Events**
2. Select your **Pixel** → **Settings**
3. Click **Generate Access Token**
4. Copy the **Pixel ID** and **Access Token**

## Event Name Mapping

Canonical events are mapped to TikTok standard events:

| Canonical Event | TikTok Event | Description |
|-----------------|--------------|-------------|
| `TRIAL_BOOKED` | `SubmitForm` | Trial lesson scheduled |
| `TRIAL_RESCHEDULED` | `SubmitForm` | Trial rescheduled |
| `TRIAL_CANCELED` | *(skipped)* | No event sent |
| `APPOINTMENT_UPDATED` | `Schedule` | Regular appointment |

### Custom Mapping

Override defaults via environment variable:

```env
TIKTOK_EVENT_ACTIONS=TRIAL_BOOKED=CompleteRegistration,APPOINTMENT_UPDATED=Contact
```

## API Request Format

### Endpoint

```
POST https://business-api.tiktok.com/open_api/v1.3/event/track/
```

### Headers

```
Content-Type: application/json
Access-Token: <your_access_token>
```

### Request Body Structure

```json
{
  "event_source": "web",
  "event_source_id": "<PIXEL_ID>",
  "partner_name": "VirtuAnalytics",
  "test_event_code": "<optional>",
  "data": [
    {
      "event": "SubmitForm",
      "event_time": 1704931200,
      "event_id": "appt-12345",
      "user": {
        "ttclid": "E.C.P.abc123...",
        "ttp": "def456...",
        "email": "a1b2c3d4e5f6...",
        "phone": "f6e5d4c3b2a1...",
        "external_id": "9876543210...",
        "ip": "192.168.1.1",
        "user_agent": "Mozilla/5.0..."
      },
      "page": {
        "url": "https://virtu.academy/schedule",
        "referrer": "https://tiktok.com"
      },
      "properties": {
        "value": 50.00,
        "currency": "USD"
      }
    }
  ]
}
```

### Field Details

#### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_source` | string | Yes | Always `"web"` |
| `event_source_id` | string | Yes | Your Pixel ID |
| `partner_name` | string | Yes | `"VirtuAnalytics"` |
| `test_event_code` | string | No | For testing only |
| `data` | array | Yes | Array of event objects |

#### Event Object Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | Yes | TikTok event name (e.g., `"SubmitForm"`) |
| `event_time` | integer | Yes | Unix timestamp (seconds) |
| `event_id` | string | Yes | Unique ID for deduplication |
| `user` | object | Yes | User identifiers (see below) |
| `page` | object | No | Page URL and referrer |
| `properties` | object | No | Conversion value and currency |

#### User Object Fields

| Field | Hashed | Required | Description |
|-------|--------|----------|-------------|
| `ttclid` | No | Conditional* | TikTok Click ID from URL |
| `ttp` | No | Conditional* | TikTok Pixel cookie |
| `email` | **SHA256** | Conditional* | User email address |
| `phone` | **SHA256** | Conditional* | User phone number |
| `external_id` | **SHA256** | No | External user ID (e.g., va_attrib) |
| `ip` | No | No | User's IP address |
| `user_agent` | No | No | User's browser user agent |

*At least one of `ttclid`, `ttp`, `email`, or `phone` is required.

## Data Hashing

PII fields are SHA256 hashed before sending to TikTok.

### Hashing Rules

1. **Email**: Lowercase, trim whitespace, SHA256
2. **Phone**: Extract digits, add country code if needed, SHA256
3. **External ID**: Trim whitespace, SHA256

### Example

```
Input:  "User@Example.com"
Step 1: "user@example.com" (lowercase)
Step 2: "5e884898da28047d..." (SHA256 hex)
```

### Phone Normalization

```
Input:  "(415) 555-1234"
Step 1: "4155551234" (digits only)
Step 2: "14155551234" (add country code "1")
Step 3: "8d969eef6ecad3c2..." (SHA256 hex)
```

## Data Flow

```
┌─────────────────┐
│ Acuity Webhook  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Create Event    │  CanonicalEvent: TRIAL_BOOKED
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Create Delivery │  Platform: TIKTOK, Status: PENDING
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ QStash Queue    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│ /api/qstash/deliver                                     │
│                                                         │
│  1. Load CanonicalEvent + Appointment + Attribution     │
│  2. Call sendTikTokEvent() with all data               │
│  3. Store requestBody + responseBody in Delivery        │
└────────┬────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│ sendTikTokEvent()                                       │
│                                                         │
│  1. Check OUTBOUND_MODE=mock                           │
│  2. Validate TIKTOK_PIXEL_ID + TIKTOK_ACCESS_TOKEN     │
│  3. Map event name (TRIAL_BOOKED → SubmitForm)         │
│  4. Check for identifiers (ttclid OR email/phone)      │
│  5. Hash PII (email, phone, external_id)               │
│  6. Build JSON request                                  │
│  7. POST to TikTok API                                  │
│  8. Parse response (check code: 0)                      │
└────────┬────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ TikTok API      │  { "code": 0, "message": "OK" }
└─────────────────┘
```

## Skip Conditions

Events are marked as `SKIPPED` (not sent to TikTok) when:

| Condition | Reason |
|-----------|--------|
| Missing credentials | `Missing env: TIKTOK_PIXEL_ID, TIKTOK_ACCESS_TOKEN` |
| No event mapping | `No TikTok event mapping for: TRIAL_CANCELED` |
| No identifiers | `Missing ttclid/ttp and user identifiers (email/phone)` |
| Mock mode enabled | `TIKTOK mock mode` |

## Response Handling

### Success Response

```json
{
  "code": 0,
  "message": "OK",
  "data": {}
}
```

### Error Response

```json
{
  "code": 40001,
  "message": "Invalid access token"
}
```

### Common Error Codes

| Code | Message | Solution |
|------|---------|----------|
| 0 | OK | Success |
| 40000 | Invalid parameter | Check request format |
| 40001 | Invalid access token | Regenerate token |
| 40002 | Rate limit exceeded | Implement backoff |
| 40100 | Pixel ID not found | Verify TIKTOK_PIXEL_ID |

## Testing

### Using Test Event Code

Set `TIKTOK_TEST_EVENT_CODE` to see events in TikTok's Test Events tab without affecting production metrics.

```env
TIKTOK_TEST_EVENT_CODE=TEST12345
```

### Manual API Testing

```bash
curl -X POST https://analytics.virtu.academy/api/test/tiktok \
  -H "Authorization: Bearer YOUR_TEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-123",
    "eventName": "TRIAL_BOOKED",
    "eventTime": "2026-01-10T12:00:00Z",
    "ttclid": "E.C.P.abc123xyz",
    "email": "test@example.com",
    "phone": "+14155551234",
    "pageUrl": "https://virtu.academy/schedule"
  }'
```

### Response Example

```json
{
  "ok": true,
  "status": 200,
  "body": "{\"code\":0,\"message\":\"OK\",\"data\":{}}",
  "requestBody": "{\"event_source\":\"web\",\"event_source_id\":\"CXXX\",\"partner_name\":\"VirtuAnalytics\",\"data\":[{\"event\":\"SubmitForm\",...}]}"
}
```

## Debugging

### Check Delivery Status

Query the GraphQL endpoint to see delivery status:

```graphql
query {
  appointments(limit: 10) {
    id
    email
    ttclid
    canonicalEvents {
      name
      eventTime
      deliveries {
        platform
        status
        requestBody
        responseBody
        responseCode
      }
    }
  }
}
```

### Verify in TikTok Events Manager

1. Go to **TikTok Ads Manager** → **Tools** → **Events**
2. Select your **Pixel**
3. Check **Test Events** tab for test events
4. Check **Overview** for production events

## Comparison with Google Ads

### Similarities

| Aspect | Implementation |
|--------|----------------|
| Auth validation | `buildAuth()` returns `{ ok, reason }` or `{ ok, auth }` |
| Event mapping | `resolve*EventName()` with env var override |
| Skip logic | Returns `{ skipped: true, reason }` |
| Request logging | Stores `requestBody` in Delivery table |
| Response logging | Stores `responseBody` and `responseCode` |
| Mock mode | Checks `OUTBOUND_MODE=mock` |
| Test endpoint | Same structure and auth pattern |

### Differences

| Aspect | Google Ads | TikTok |
|--------|-----------|--------|
| Auth | OAuth 2.0 token refresh | Static access token |
| API format | REST with custom headers | REST with JSON body |
| Time format | `2026-01-10 12:00:00+00:00` | Unix timestamp (seconds) |
| Success check | `res.ok && !partialFailureError` | `res.ok && code === 0` |
| Phone format | E.164 with `+` prefix | Digits only |
| Additional data | `userIpAddress` only | `userAgent`, `pageUrl`, `pageReferrer` |

## Files

| File | Purpose |
|------|---------|
| `src/lib/outbound/tiktok.ts` | Main TikTok API integration |
| `src/app/api/test/tiktok/route.ts` | Manual testing endpoint |
| `src/app/api/qstash/deliver/route.ts` | Delivery handler (calls sendTikTokEvent) |
| `docs/TIKTOK_INTEGRATION.md` | This documentation |
| `TIKTOK_INTEGRATION_PLAN.md` | Original implementation plan |
