import { sha256Hex } from "../crypto";

/**
 * TikTok Events API Integration
 *
 * This module sends conversion events to TikTok's Events API (v1.3).
 * It mirrors the Google Ads integration pattern for consistency.
 *
 * API Endpoint: POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 *
 * Required Environment Variables:
 *   - TIKTOK_PIXEL_ID: Your TikTok Pixel ID (event_source_id)
 *   - TIKTOK_ACCESS_TOKEN: Events API access token from TikTok Ads Manager
 *
 * Optional Environment Variables:
 *   - TIKTOK_TEST_EVENT_CODE: Test event code for debugging (events appear in Test Events tab)
 *   - TIKTOK_DEFAULT_PHONE_COUNTRY_CODE: Default country code for phone numbers (e.g., "1" for US)
 *   - TIKTOK_EVENT_ACTIONS: Custom event name mapping (e.g., "TRIAL_BOOKED=SubmitForm,APPOINTMENT_UPDATED=Schedule")
 *
 * @see https://github.com/tiktok/gtm-template-eapi (Official TikTok GTM template)
 * @see https://github.com/tiktok/tiktok-business-api-sdk (Official TikTok SDK)
 */

const TIKTOK_API_VERSION = "v1.3";
const TIKTOK_API_ENDPOINT = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}/event/track/`;
const PARTNER_NAME = "VirtuAnalytics";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Arguments for sending a TikTok conversion event.
 * Mirrors the structure of GoogleAdsClickConversionArgs for consistency.
 */
export type TikTokEventArgs = {
  /** Unique event identifier for deduplication (required) */
  eventId: string;

  /** Canonical event name (e.g., "TRIAL_BOOKED", "APPOINTMENT_UPDATED") */
  eventName?: string | null;

  /** When the conversion event occurred */
  eventTime: Date;

  /** Conversion value amount */
  conversionValue?: number | null;

  /** Currency code (ISO 4217, e.g., "USD") */
  currencyCode?: string | null;

  // Click identifiers
  /** TikTok Click ID from URL parameter (ttclid) */
  ttclid?: string | null;

  /** TikTok Pixel cookie value (_ttp) */
  ttp?: string | null;

  // User identifiers (will be SHA256 hashed before sending)
  /** User email address (will be hashed) */
  email?: string | null;

  /** User phone number (will be hashed) */
  phone?: string | null;

  /** External user ID, e.g., va_attrib token (will be hashed) */
  externalId?: string | null;

  // Context data (NOT hashed)
  /** User's IP address */
  userIpAddress?: string | null;

  /** User's browser user agent */
  userAgent?: string | null;

  // Page data
  /** URL where the conversion occurred */
  pageUrl?: string | null;

  /** Referrer URL */
  pageReferrer?: string | null;
};

/**
 * Result of sending a TikTok event.
 * Mirrors GoogleAdsSendResult for consistency.
 */
export type TikTokSendResult =
  | { skipped: true; reason: string; requestBody: string }
  | { skipped: false; ok: boolean; status: number; body: string; requestBody: string };

/**
 * TikTok API authentication configuration.
 */
type TikTokAuth = {
  pixelId: string;
  accessToken: string;
};

// ============================================================================
// Hashing Functions
// ============================================================================

/**
 * Normalizes a string for hashing: trims whitespace and converts to lowercase.
 * This follows TikTok's requirements for PII hashing.
 */
function normalizeForHash(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Hashes a value for TikTok using SHA256.
 * Returns lowercase hex string (64 characters).
 */
function hashForTikTok(value: string): string {
  return sha256Hex(normalizeForHash(value));
}

/**
 * Checks if a value is already SHA256 hashed (64-character hex string).
 */
function isAlreadyHashed(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

/**
 * Extracts first valid email from a potentially malformed string.
 * Handles comma/space separated lists.
 */
function extractEmailCandidate(value: string): string | null {
  const candidates = value.split(/[,\s;]/).map(part => part.trim()).filter(Boolean);
  return candidates.find(candidate => candidate.includes("@")) ?? null;
}

/**
 * Hashes an email address for TikTok.
 * Returns null if email is invalid or missing.
 *
 * Processing:
 * 1. Extract valid email from string
 * 2. Trim and lowercase
 * 3. Hash with SHA256
 */
function hashEmail(value?: string | null): string | null {
  if (!value) return null;

  // Check if already hashed
  if (isAlreadyHashed(value)) return value.toLowerCase();

  const candidate = extractEmailCandidate(value);
  if (!candidate) return null;

  const normalized = candidate.trim().toLowerCase();
  if (!normalized.includes("@")) return null;

  return hashForTikTok(normalized);
}

/**
 * Normalizes a country code to digits only.
 */
function normalizeCountryCode(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits || null;
}

/**
 * Hashes a phone number for TikTok.
 * Returns null if phone is invalid or missing.
 *
 * Processing:
 * 1. Strip non-digit characters
 * 2. Add country code if missing
 * 3. Validate length (8-15 digits)
 * 4. Hash with SHA256
 */
function hashPhone(value?: string | null, defaultCountryCode?: string | null): string | null {
  if (!value) return null;

  // Check if already hashed
  if (isAlreadyHashed(value)) return value.toLowerCase();

  // Extract digits, preserving leading +
  const trimmed = value.trim();
  let digits: string;

  if (trimmed.startsWith("+")) {
    // International format - extract all digits
    digits = trimmed.replace(/\D+/g, "");
  } else {
    // Local format - may need country code
    digits = trimmed.replace(/\D+/g, "");

    // Add default country code if number appears to be local (10 or fewer digits)
    if (digits.length <= 10) {
      const countryCode = normalizeCountryCode(defaultCountryCode);
      if (countryCode) {
        digits = countryCode + digits;
      }
    }
  }

  if (!digits) return null;

  // Validate phone number length (E.164: 8-15 digits)
  if (digits.length < 8 || digits.length > 15) return null;

  return hashForTikTok(digits);
}

/**
 * Hashes an external ID for TikTok.
 */
function hashExternalId(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Check if already hashed
  if (isAlreadyHashed(trimmed)) return trimmed.toLowerCase();

  return hashForTikTok(trimmed);
}

// ============================================================================
// Event Name Mapping
// ============================================================================

/**
 * Default event name mapping from canonical events to TikTok events.
 *
 * TikTok Standard Events (from official GTM template):
 * - SubmitForm: Form submissions, lead generation
 * - CompleteRegistration: Sign-ups, account creation
 * - Schedule: Appointment scheduling
 * - Contact: Contact form submissions
 * - ViewContent: Page/content views
 * - AddToCart, InitiateCheckout, Purchase: E-commerce events
 */
const DEFAULT_EVENT_MAPPING: Record<string, string> = {
  TRIAL_BOOKED: "SubmitForm",
  TRIAL_RESCHEDULED: "SubmitForm",
  APPOINTMENT_UPDATED: "Schedule"
  // TRIAL_CANCELED is intentionally omitted - we skip canceled events
};

/**
 * Parses custom event mapping from environment variable.
 * Format: "EVENT_NAME=TikTokEvent,EVENT_NAME2=TikTokEvent2"
 */
function parseEventMapping(value?: string | null): Record<string, string> {
  if (!value) return {};
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [eventName, tiktokEvent] = pair.split("=").map(part => part.trim());
    if (eventName && tiktokEvent) map[eventName] = tiktokEvent;
  }
  return map;
}

/**
 * Resolves a canonical event name to a TikTok event name.
 * Returns null if the event should be skipped.
 *
 * Priority:
 * 1. Custom mapping from TIKTOK_EVENT_ACTIONS env var
 * 2. Default mapping (DEFAULT_EVENT_MAPPING)
 * 3. null (skip the event)
 */
function resolveTikTokEventName(canonicalName?: string | null): string | null {
  if (!canonicalName) return null;

  // Check custom mapping first
  const customMapping = parseEventMapping(process.env.TIKTOK_EVENT_ACTIONS);
  if (customMapping[canonicalName]) {
    return customMapping[canonicalName];
  }

  // Fall back to default mapping
  return DEFAULT_EVENT_MAPPING[canonicalName] ?? null;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Builds TikTok authentication from environment variables.
 * Mirrors the buildAuth() pattern from Google Ads.
 */
function buildAuth(): { ok: true; auth: TikTokAuth } | { ok: false; reason: string } {
  const pixelId = process.env.TIKTOK_PIXEL_ID?.trim();
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN?.trim();

  if (!pixelId || !accessToken) {
    const missing: string[] = [];
    if (!pixelId) missing.push("TIKTOK_PIXEL_ID");
    if (!accessToken) missing.push("TIKTOK_ACCESS_TOKEN");
    return { ok: false, reason: `Missing env: ${missing.join(", ")}` };
  }

  return { ok: true, auth: { pixelId, accessToken } };
}

// ============================================================================
// Request Building
// ============================================================================

/**
 * Converts a Date to Unix timestamp in seconds.
 * TikTok expects event_time as seconds since epoch.
 */
function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Builds the user object for TikTok event data.
 * Includes hashed PII and context data.
 */
function buildUserObject(
  args: TikTokEventArgs,
  hashedEmail: string | null,
  hashedPhone: string | null,
  hashedExternalId: string | null
): Record<string, string> {
  const user: Record<string, string> = {};

  // Click identifiers (not hashed)
  if (args.ttclid?.trim()) user.ttclid = args.ttclid.trim();
  if (args.ttp?.trim()) user.ttp = args.ttp.trim();

  // Hashed user identifiers
  if (hashedEmail) user.email = hashedEmail;
  if (hashedPhone) user.phone = hashedPhone;
  if (hashedExternalId) user.external_id = hashedExternalId;

  // Context data (not hashed)
  if (args.userIpAddress?.trim()) user.ip = args.userIpAddress.trim();
  if (args.userAgent?.trim()) user.user_agent = args.userAgent.trim();

  return user;
}

/**
 * Builds the page object for TikTok event data.
 */
function buildPageObject(args: TikTokEventArgs): Record<string, string> | null {
  const page: Record<string, string> = {};

  if (args.pageUrl?.trim()) page.url = args.pageUrl.trim();
  if (args.pageReferrer?.trim()) page.referrer = args.pageReferrer.trim();

  return Object.keys(page).length > 0 ? page : null;
}

/**
 * Builds the properties object for TikTok event data.
 */
function buildPropertiesObject(args: TikTokEventArgs): Record<string, unknown> | null {
  if (args.conversionValue == null || !Number.isFinite(args.conversionValue)) {
    return null;
  }

  return {
    value: args.conversionValue,
    currency: args.currencyCode?.trim() || "USD"
  };
}

// ============================================================================
// Main Send Function
// ============================================================================

/**
 * Sends a conversion event to TikTok's Events API.
 *
 * This function mirrors the sendGoogleAdsClickConversion pattern:
 * 1. Check for mock mode
 * 2. Validate authentication
 * 3. Resolve event name
 * 4. Check for required identifiers
 * 5. Build and send request
 * 6. Return structured result
 *
 * @param args - Event arguments
 * @returns Result object with skipped flag, or HTTP response details
 *
 * @example
 * ```typescript
 * const result = await sendTikTokEvent({
 *   eventId: "appt-123",
 *   eventName: "TRIAL_BOOKED",
 *   eventTime: new Date(),
 *   ttclid: "click-id-from-url",
 *   email: "user@example.com",
 *   phone: "+14155551234"
 * });
 *
 * if (result.skipped) {
 *   console.log("Skipped:", result.reason);
 * } else {
 *   console.log("Sent:", result.ok, result.status);
 * }
 * ```
 */
export async function sendTikTokEvent(args: TikTokEventArgs): Promise<TikTokSendResult> {
  // 1. Check for mock mode (same as Google Ads)
  if (process.env.OUTBOUND_MODE === "mock") {
    return {
      skipped: true,
      reason: "TIKTOK mock mode",
      requestBody: JSON.stringify(args)
    };
  }

  // 2. Validate authentication
  const authResult = buildAuth();
  if (!authResult.ok) {
    return {
      skipped: true,
      reason: authResult.reason,
      requestBody: JSON.stringify(args)
    };
  }

  // 3. Resolve event name (skip if no mapping exists)
  const tiktokEventName = resolveTikTokEventName(args.eventName);
  if (!tiktokEventName) {
    return {
      skipped: true,
      reason: `No TikTok event mapping for: ${args.eventName ?? "(none)"}`,
      requestBody: JSON.stringify(args)
    };
  }

  // 4. Hash user identifiers
  const defaultCountryCode = process.env.TIKTOK_DEFAULT_PHONE_COUNTRY_CODE ?? null;
  const hashedEmail = hashEmail(args.email);
  const hashedPhone = hashPhone(args.phone, defaultCountryCode);
  const hashedExternalId = hashExternalId(args.externalId);

  // 5. Check for required identifiers (ttclid OR email/phone)
  // This mirrors Google Ads: skip if no click IDs AND no user identifiers
  const ttclid = args.ttclid?.trim() || null;
  const ttp = args.ttp?.trim() || null;

  if (!ttclid && !ttp && !hashedEmail && !hashedPhone) {
    return {
      skipped: true,
      reason: "Missing ttclid/ttp and user identifiers (email/phone)",
      requestBody: JSON.stringify(args)
    };
  }

  // 6. Build user object
  const user = buildUserObject(args, hashedEmail, hashedPhone, hashedExternalId);

  // 7. Build event data object
  const eventData: Record<string, unknown> = {
    event: tiktokEventName,
    event_time: toUnixSeconds(args.eventTime),
    event_id: args.eventId,
    user
  };

  // Add page data if available
  const page = buildPageObject(args);
  if (page) eventData.page = page;

  // Add properties if conversion value is set
  const properties = buildPropertiesObject(args);
  if (properties) eventData.properties = properties;

  // 8. Build full request payload
  const request: Record<string, unknown> = {
    event_source: "web",
    event_source_id: authResult.auth.pixelId,
    partner_name: PARTNER_NAME,
    data: [eventData]
  };

  // Add test event code if configured (for debugging in TikTok Events Manager)
  const testEventCode = process.env.TIKTOK_TEST_EVENT_CODE?.trim();
  if (testEventCode) {
    request.test_event_code = testEventCode;
  }

  const requestBody = JSON.stringify(request);

  // 9. Send request to TikTok API
  try {
    const res = await fetch(TIKTOK_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": authResult.auth.accessToken
      },
      body: requestBody,
      cache: "no-store"
    });

    const text = await res.text();

    // 10. Parse response
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    // TikTok returns { code: 0, message: "OK" } on success
    // Non-zero codes indicate errors
    const responseCode =
      parsed && typeof parsed === "object" ? (parsed as { code?: number }).code : null;
    const ok = res.ok && responseCode === 0;
    const body = parsed ? JSON.stringify(parsed) : text;

    return { skipped: false, ok, status: res.status, body, requestBody };
  } catch (error) {
    // Network or other errors
    const message = error instanceof Error ? error.message : "Unknown error";
    return { skipped: false, ok: false, status: 500, body: message, requestBody };
  }
}
