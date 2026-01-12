import { sha256Hex } from "../crypto";

const GOOGLE_ADS_API_VERSION = "v22";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

type GoogleAdsClickConversionArgs = {
  eventId: string;
  eventName?: string | null;
  eventTime: Date;
  conversionValue?: number | null;
  currencyCode?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  orderId?: string | null;
  userIpAddress?: string | null;
};

type GoogleAdsSendResult =
  | { skipped: true; reason: string }
  | { skipped: false; ok: boolean; status: number; body: string; requestBody: string };

type ConsentStatus = "GRANTED" | "DENIED";

type GoogleAdsAuth = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let accessTokenPromise: Promise<string> | null = null;

function isTruthy(value?: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function normalizeCustomerId(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits ? digits : null;
}

function normalizeForHash(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function extractEmailCandidate(value: string): string | null {
  const candidates = value.split(/[,\s;]/).map(part => part.trim()).filter(Boolean);
  return candidates.find(candidate => candidate.includes("@")) ?? null;
}

function normalizeEmailForHash(value: string): string | null {
  const candidate = extractEmailCandidate(value);
  if (!candidate) return null;
  const cleaned = candidate.trim().toLowerCase().replace(/\s+/g, "");
  const parts = cleaned.split("@");
  if (parts.length !== 2) return null;
  let local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return null;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    local = local.split("+")[0] ?? local;
  }
  return `${local}@${domain}`;
}

function hashEmail(value?: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeEmailForHash(value);
  return normalized ? sha256Hex(normalizeForHash(normalized)) : null;
}

function normalizeCountryCode(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits ? digits : null;
}

function normalizePhoneToE164(value: string, defaultCountryCode?: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const plusDigits = trimmed.replace(/[^\d+]/g, "");
  if (plusDigits.startsWith("+")) {
    const digitsOnly = plusDigits.replace(/\D+/g, "");
    if (!digitsOnly) return null;
    const normalized = `+${digitsOnly}`;
    const len = digitsOnly.length;
    return len >= 8 && len <= 15 ? normalized : null;
  }

  const digitsOnly = trimmed.replace(/\D+/g, "");
  if (!digitsOnly) return null;
  const countryCode = normalizeCountryCode(defaultCountryCode);
  if (!countryCode) return null;
  if (digitsOnly.startsWith(countryCode)) {
    const normalized = `+${digitsOnly}`;
    const len = normalized.replace(/\D+/g, "").length;
    if (len >= 8 && len <= 15 && (countryCode !== "1" || digitsOnly.length === 11)) {
      return normalized;
    }
  }
  const normalized = `+${countryCode}${digitsOnly}`;
  const len = normalized.replace(/\D+/g, "").length;
  return len >= 8 && len <= 15 ? normalized : null;
}

function hashPhone(value?: string | null, defaultCountryCode?: string | null): string | null {
  if (!value) return null;
  const normalized = normalizePhoneToE164(value, defaultCountryCode);
  return normalized ? sha256Hex(normalizeForHash(normalized)) : null;
}

function parseOffsetMinutes(value?: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === "Z" || trimmed === "UTC") return 0;
  const match = trimmed.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return sign * (hours * 60 + minutes);
}

function getOffsetMinutesForTimeZone(date: Date, timeZone?: string | null): number | null {
  if (!timeZone) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
    const parts = formatter.formatToParts(date);
    const tzName = parts.find(part => part.type === "timeZoneName")?.value ?? "";
    if (tzName === "GMT" || tzName === "UTC") return 0;
    const match = tzName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return null;
    const sign = match[1].startsWith("-") ? -1 : 1;
    const hours = Math.abs(Number(match[1]));
    const minutes = match[2] ? Number(match[2]) : 0;
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return sign * (hours * 60 + minutes);
  } catch {
    return null;
  }
}

function formatOffsetMinutes(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatGoogleAdsDateTime(date: Date, timeZone?: string | null, offsetOverride?: string | null): string {
  const offsetMinutes = parseOffsetMinutes(offsetOverride) ?? getOffsetMinutesForTimeZone(date, timeZone) ?? 0;
  const local = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const ss = String(local.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}${formatOffsetMinutes(offsetMinutes)}`;
}

function isClickNotFoundOnly(partialFailureError: unknown): boolean {
  if (!partialFailureError || typeof partialFailureError !== "object") return false;
  const details = (partialFailureError as { details?: unknown }).details;
  if (!Array.isArray(details)) return false;
  const errors = details.flatMap(detail => {
    const nested = (detail as { errors?: unknown }).errors;
    return Array.isArray(nested) ? nested : [];
  });
  if (errors.length === 0) return false;
  return errors.every(error => {
    const code = (error as { errorCode?: { conversionUploadError?: string } }).errorCode?.conversionUploadError;
    return code === "CLICK_NOT_FOUND";
  });
}

function parseConversionActionMap(value?: string | null): Record<string, string> {
  if (!value) return {};
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [eventName, actionId] = pair.split("=").map(part => part.trim());
    if (eventName && actionId) map[eventName] = actionId;
  }
  return map;
}

function resolveConversionActionId(eventName: string | null | undefined): string | null {
  const mapping = parseConversionActionMap(process.env.GOOGLE_ADS_CONVERSION_ACTIONS);
  if (eventName && mapping[eventName]) return mapping[eventName];
  const fallback = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  return fallback ? fallback.trim() : null;
}

function toConversionActionResourceName(customerId: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("/")) return trimmed;
  const id = trimmed.replace(/\D+/g, "");
  return `customers/${customerId}/conversionActions/${id}`;
}

function buildAuth(): { ok: true; auth: GoogleAdsAuth } | { ok: false; reason: string } {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const customerId = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const loginCustomerId = normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) {
    const missing: string[] = [];
    if (!developerToken) missing.push("GOOGLE_ADS_DEVELOPER_TOKEN");
    if (!clientId) missing.push("GOOGLE_ADS_CLIENT_ID");
    if (!clientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
    if (!refreshToken) missing.push("GOOGLE_ADS_REFRESH_TOKEN");
    if (!customerId) missing.push("GOOGLE_ADS_CUSTOMER_ID");

    return { ok: false, reason: `Missing env: ${missing.join(", ")}` };
  }

  return {
    ok: true,
    auth: {
      developerToken,
      clientId,
      clientSecret,
      refreshToken,
      customerId,
      loginCustomerId: loginCustomerId ?? undefined
    }
  };
}

async function fetchAccessToken(auth: GoogleAdsAuth): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  if (accessTokenPromise) return accessTokenPromise;

  accessTokenPromise = (async () => {
    const params = new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token"
    });

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      cache: "no-store"
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OAuth token request failed: ${res.status} ${text}`);
    }

    const payload = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error("OAuth token response missing access_token");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    cachedAccessToken = { token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return payload.access_token;
  })();

  try {
    return await accessTokenPromise;
  } finally {
    accessTokenPromise = null;
  }
}

function parseJobId(value?: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= 2 ** 31) return undefined;
  return String(parsed);
}

function buildUserIdentifiers(args: GoogleAdsClickConversionArgs) {
  const defaultCountryCode = process.env.GOOGLE_ADS_DEFAULT_PHONE_COUNTRY_CODE ?? null;
  const identifiers: Array<Record<string, unknown>> = [];

  const hashedEmail = hashEmail(args.email ?? null);
  if (hashedEmail) {
    identifiers.push({ userIdentifierSource: "FIRST_PARTY", hashedEmail });
  }

  const hashedPhone = hashPhone(args.phone ?? null, defaultCountryCode);
  if (hashedPhone) {
    identifiers.push({ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: hashedPhone });
  }

  return identifiers;
}

function buildConsent() {
  const consent: Record<string, ConsentStatus> = {
    adUserData: "GRANTED",
    adPersonalization: "GRANTED"
  };
  return consent;
}

export async function sendGoogleAdsClickConversion(args: GoogleAdsClickConversionArgs): Promise<GoogleAdsSendResult> {
  if (process.env.OUTBOUND_MODE === "mock") {
    return { skipped: true, reason: "GOOGLE_ADS mock mode" };
  }

  const authResult = buildAuth();
  if (!authResult.ok) return { skipped: true, reason: authResult.reason };

  const conversionActionId = resolveConversionActionId(args.eventName ?? null);
  if (!conversionActionId) {
    return { skipped: true, reason: "Missing GOOGLE_ADS_CONVERSION_ACTION_ID(S)" };
  }

  const identifiers = buildUserIdentifiers(args);
  const gclid = args.gclid?.trim() || null;
  const gbraid = args.gbraid?.trim() || null;
  const wbraid = args.wbraid?.trim() || null;

  if (!gclid && !gbraid && !wbraid && identifiers.length === 0) {
    return { skipped: true, reason: "Missing click IDs and user identifiers" };
  }

  const customerId = authResult.auth.customerId;
  const conversionAction = toConversionActionResourceName(customerId, conversionActionId);
  const timeZone = process.env.GOOGLE_ADS_CONVERSION_TIMEZONE ?? null;
  const timeZoneOffset = process.env.GOOGLE_ADS_CONVERSION_TIMEZONE_OFFSET ?? null;
  const conversionDateTime = formatGoogleAdsDateTime(args.eventTime, timeZone, timeZoneOffset);

  const conversion: Record<string, unknown> = {
    conversionAction,
    conversionDateTime,
    conversionEnvironment: "WEB"
  };

  if (args.conversionValue != null && Number.isFinite(args.conversionValue)) {
    conversion.conversionValue = args.conversionValue;
    if (args.currencyCode) {
      conversion.currencyCode = args.currencyCode;
    }
  }

  const orderId = args.orderId ?? args.eventId;
  if (orderId) conversion.orderId = orderId;
  if (gclid) conversion.gclid = gclid;
  if (gbraid) conversion.gbraid = gbraid;
  if (wbraid) conversion.wbraid = wbraid;
  if (identifiers.length > 0) conversion.userIdentifiers = identifiers;
  if (args.userIpAddress) conversion.userIpAddress = args.userIpAddress;
  //TODO: If it's a new customer, "customerType":"NEW"
  //TODO: Add sessionAttributes (https://developers.google.com/google-ads/api/reference/rpc/v22/ConversionUploadService/UploadClickConversions?transport=rest#SessionAttributeKeyValuePair)
  //TODO: set conversion values and order ID too.
  //TODO: add filter for no scheduledby field 
  const consent = buildConsent();
  if (consent) conversion.consent = consent;

  const request: Record<string, unknown> = {
    customerId,
    conversions: [conversion],
    partialFailure: true
  };

  const jobId = parseJobId(process.env.GOOGLE_ADS_JOB_ID);
  if (jobId) request.jobId = jobId;
  if (isTruthy(process.env.GOOGLE_ADS_VALIDATE_ONLY)) request.validateOnly = true;
  const requestBody = JSON.stringify(request);

  let accessToken: string;
  try {
    accessToken = await fetchAccessToken(authResult.auth);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth token request failed";
    return { skipped: false, ok: false, status: 500, body: message, requestBody };
  }

  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": authResult.auth.developerToken,
    "Content-Type": "application/json"
  };
  if (authResult.auth.loginCustomerId) {
    headers["login-customer-id"] = authResult.auth.loginCustomerId;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
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

  const partialFailureError =
    parsed && typeof parsed === "object" && "partialFailureError" in parsed
      ? (parsed as { partialFailureError?: unknown }).partialFailureError
      : null;

  const body = parsed ? JSON.stringify(parsed) : text;
  const ok = res.ok && (!partialFailureError || isClickNotFoundOnly(partialFailureError));
  return { skipped: false, ok, status: res.status, body, requestBody };
}
