import { toUnixSeconds } from "../normalize";
import { sha256Hex } from "../crypto";

const META_CAPI_API_VERSION_DEFAULT = "v24.0";

// --- Types ---

type MetaCapiAuth = {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
  apiVersion: string;
};

type MetaUserData = {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  st?: string[];
  zp?: string[];
  country?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
};

type MetaCapiArgs = {
  eventId: string;
  eventName?: string | null;
  eventTime: Date;
  eventSourceUrl: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  externalId?: string | null;
  value?: number | null;
  currency?: string | null;
  customData?: Record<string, unknown>;
};

type MetaCapiResult =
  | { skipped: true; reason: string }
  | { skipped: false; ok: boolean; status: number; body: string; requestBody: string };

// --- Configuration ---

function buildMetaAuth(): { ok: true; auth: MetaCapiAuth } | { ok: false; reason: string } {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE;
  const apiVersion = process.env.META_CAPI_API_VERSION ?? META_CAPI_API_VERSION_DEFAULT;

  if (!pixelId || !accessToken) {
    const missing: string[] = [];
    if (!pixelId) missing.push("META_PIXEL_ID");
    if (!accessToken) missing.push("META_CAPI_ACCESS_TOKEN");
    return { ok: false, reason: `Missing env: ${missing.join(", ")}` };
  }

  return { ok: true, auth: { pixelId, accessToken, testEventCode, apiVersion } };
}

// --- Event Name Mapping ---

function parseEventNameMap(value?: string | null): Record<string, string> {
  if (!value) return {};
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [eventName, metaEvent] = pair.split("=").map((part) => part.trim());
    if (eventName && metaEvent) map[eventName] = metaEvent;
  }
  return map;
}

function resolveMetaEventName(canonicalEventName?: string | null): string | null {
  const mapping = parseEventNameMap(process.env.META_CAPI_EVENT_NAMES);
  const hasMapping = Object.keys(mapping).length > 0;
  if (canonicalEventName && mapping[canonicalEventName]) {
    return mapping[canonicalEventName];
  }
  const fallback = process.env.META_CAPI_EVENT_NAME;
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  if (hasMapping) {
    return null;
  }
  const defaults: Record<string, string> = {
    TRIAL_BOOKED: "SubmitApplication",
    TRIAL_RESCHEDULED: "Schedule",
    TRIAL_CANCELED: "Cancel",
    APPOINTMENT_UPDATED: "Schedule",
  };
  return canonicalEventName && defaults[canonicalEventName] ? defaults[canonicalEventName] : "Lead";
}

// --- Normalization Functions ---

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function extractEmailCandidate(value: string): string | null {
  const candidates = value
    .split(/[,\s;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return candidates.find((candidate) => candidate.includes("@")) ?? null;
}

function normalizeEmailForMeta(value?: string | null): string | null {
  if (!value) return null;
  const candidate = extractEmailCandidate(value);
  if (!candidate) return null;
  const cleaned = candidate.trim().toLowerCase().replace(/\s+/g, "");
  const parts = cleaned.split("@");
  if (parts.length !== 2) return null;
  let local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return null;
  // Gmail special handling: remove dots and aliases
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    local = local.split("+")[0] ?? local;
  }
  return `${local}@${domain}`;
}

function normalizeCountryCode(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits ? digits : null;
}

function normalizePhoneForMeta(
  value?: string | null,
  defaultCountryCode?: string | null,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Meta requires digits only (no + prefix)
  const plusDigits = trimmed.replace(/[^\d+]/g, "");
  if (plusDigits.startsWith("+")) {
    const digitsOnly = plusDigits.replace(/\D/g, "");
    return digitsOnly.length >= 7 ? digitsOnly : null;
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  if (!digitsOnly) return null;
  const countryCode = normalizeCountryCode(defaultCountryCode);
  if (!countryCode) return digitsOnly.length >= 7 ? digitsOnly : null;
  if (digitsOnly.startsWith(countryCode)) {
    const len = digitsOnly.length;
    if (len >= 8 && len <= 15 && (countryCode !== "1" || digitsOnly.length === 11)) {
      return digitsOnly;
    }
  }
  const normalized = `${countryCode}${digitsOnly}`;
  return normalized.length >= 7 ? normalized : null;
}

function normalizeNameForMeta(value?: string | null): string | null {
  if (!value) return null;
  // Lowercase, letters only (a-z)
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized.length > 0 ? normalized : null;
}

function normalizeStateForMeta(value?: string | null): string | null {
  if (!value) return null;
  // 2-letter state code, lowercase
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized.length === 2 ? normalized : null;
}

function normalizeZipForMeta(value?: string | null): string | null {
  if (!value) return null;
  // First 5 digits for US zip codes
  const digits = value.replace(/\D/g, "");
  return digits.length >= 5 ? digits.substring(0, 5) : null;
}

function normalizeCountryForMeta(value?: string | null): string | null {
  if (!value) return null;
  // 2-letter country code, lowercase
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized.length === 2 ? normalized : null;
}

function normalizeCityForMeta(value?: string | null): string | null {
  if (!value) return null;
  // Lowercase, letters only, no spaces
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return normalized.length > 0 ? normalized : null;
}

// --- User Data Builder ---

function buildUserData(args: MetaCapiArgs): MetaUserData {
  const userData: MetaUserData = {};
  const defaultCountryCode = process.env.GOOGLE_ADS_DEFAULT_PHONE_COUNTRY_CODE ?? null;

  // Hashed identifiers (all normalized then hashed)
  const email = normalizeEmailForMeta(args.email);
  if (email) userData.em = [sha256Hex(normalizeForHash(email))];

  const phone = normalizePhoneForMeta(args.phone, defaultCountryCode);
  if (phone) userData.ph = [sha256Hex(phone)];

  const firstName = normalizeNameForMeta(args.firstName);
  if (firstName) userData.fn = [sha256Hex(firstName)];

  const lastName = normalizeNameForMeta(args.lastName);
  if (lastName) userData.ln = [sha256Hex(lastName)];

  const city = normalizeCityForMeta(args.city);
  if (city) userData.ct = [sha256Hex(city)];

  const state = normalizeStateForMeta(args.state);
  if (state) userData.st = [sha256Hex(state)];

  const zipCode = normalizeZipForMeta(args.zipCode);
  if (zipCode) userData.zp = [sha256Hex(zipCode)];

  const country = normalizeCountryForMeta(args.country);
  if (country) userData.country = [sha256Hex(country)];

  // External ID (hashed) - for cross-platform deduplication
  if (args.externalId) {
    userData.external_id = [sha256Hex(args.externalId)];
  }

  // Not hashed - these are Meta's identifiers or context
  if (args.ip) userData.client_ip_address = args.ip;
  if (args.userAgent) userData.client_user_agent = args.userAgent;
  if (args.fbc) userData.fbc = args.fbc;
  if (args.fbp) userData.fbp = args.fbp;

  return userData;
}

// --- Custom Data Builder ---

function buildCustomData(args: MetaCapiArgs): Record<string, unknown> {
  const customData: Record<string, unknown> = {};

  // Copy provided custom data first
  if (args.customData) {
    Object.assign(customData, args.customData);
  }

  // Add value and currency if provided
  if (args.value != null && Number.isFinite(args.value)) {
    customData.value = args.value;
  }
  if (args.currency) {
    customData.currency = args.currency.toUpperCase();
  }

  return customData;
}

// --- Data Processing Options (LDU for CCPA/GDPR) ---

function buildDataProcessingOptions(): {
  data_processing_options: string[];
  data_processing_options_country?: number;
  data_processing_options_state?: number;
} {
  const lduEnabled = process.env.META_CAPI_LDU_ENABLED === "true";
  if (lduEnabled) {
    return {
      data_processing_options: ["LDU"],
      data_processing_options_country: 1, // US
      data_processing_options_state: 1000, // California
    };
  }
  return { data_processing_options: [] };
}

// --- Main Export ---

export async function sendMetaCapi(args: MetaCapiArgs): Promise<MetaCapiResult> {
  if (process.env.OUTBOUND_MODE === "mock") {
    return { skipped: true, reason: "META mock mode" };
  }

  const authResult = buildMetaAuth();
  if (!authResult.ok) {
    return { skipped: true, reason: authResult.reason };
  }

  const { pixelId, accessToken, testEventCode, apiVersion } = authResult.auth;
  const metaEventName = resolveMetaEventName(args.eventName);
  if (!metaEventName) {
    return { skipped: true, reason: "Missing META_CAPI_EVENT_NAME(S)" };
  }
  const userData = buildUserData(args);
  if (Object.keys(userData).length === 0) {
    return { skipped: true, reason: "Missing user data" };
  }
  const customData = buildCustomData(args);
  const dataProcessingOptions = buildDataProcessingOptions();

  const eventData: Record<string, unknown> = {
    event_name: metaEventName,
    event_time: toUnixSeconds(args.eventTime),
    event_id: args.eventId,
    action_source: "website",
    event_source_url: args.eventSourceUrl,
    user_data: userData,
    custom_data: customData,
    ...dataProcessingOptions,
  };

  const payload: Record<string, unknown> = {
    data: [eventData],
  };

  // Add test event code if configured (for Events Manager debugging)
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const requestBody = JSON.stringify(payload);

  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
    cache: "no-store",
  });

  const text = await res.text();

  // Parse response to check for errors
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  // Meta returns { events_received: 1, messages: [], fbtrace_id: "..." } on success
  // On error: { error: { message: "...", type: "...", code: ... } }
  const hasError = parsed && typeof parsed === "object" && "error" in parsed;
  const ok = res.ok && !hasError;

  return {
    skipped: false,
    ok,
    status: res.status,
    body: parsed ? JSON.stringify(parsed) : text,
    requestBody,
  };
}
