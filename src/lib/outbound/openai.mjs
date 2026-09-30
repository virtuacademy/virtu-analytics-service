// @ts-check
import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * @typedef {{ eventId: string, eventName: string, eventTime: Date,
 * eventSourceUrl: string, email?: string | null, phone?: string | null,
 * ip?: string | null, userAgent?: string | null }} OpenAIConversion
 * @typedef {{ skipped: true, reason: string } |
 * { skipped: false, ok: boolean, validated: boolean, retryable: boolean,
 * status: number, body: string, requestBody: string }} OpenAIConversionResult
 */

const ENDPOINT = "https://bzr.openai.com/v1/events";
const hash = (/** @type {string} */ value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** @param {string | null | undefined} value */
function emailHash(value) {
  const normalized = value?.trim().toLowerCase();
  // OpenAI preserves dots and plus aliases; do not reuse Meta's Gmail normalization.
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? hash(normalized) : undefined;
}

/** @param {string | null | undefined} value @param {string | undefined} countryCode */
function phoneHash(value, countryCode) {
  if (!value) return undefined;
  let normalized = value
    .replace(/[\s().-]/g, "")
    .replace(/^\+/, "")
    .replace(/^0+/, "");
  if (!/^[0-9]{8,15}$/.test(normalized)) return undefined;
  // Acuity snapshots store digits only. National ten-digit numbers need explicit configuration.
  if (normalized.length === 10 && !value.trim().startsWith("+")) {
    if (!countryCode || !/^[1-9][0-9]{0,2}$/.test(countryCode)) return undefined;
    normalized = `${countryCode}${normalized}`;
  }
  return hash(normalized);
}

/** @param {string} value */
function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["virtu.academy", "www.virtu.academy"].includes(url.hostname))
      return null;
    // Queries/fragments may contain PII or tokens. Send only the page location.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Send one server-side booking event using the separate Conversions API credential.
 * No campaign or Advertiser API calls. Defaults to disabled and validation-only.
 * @param {OpenAIConversion} args
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now?: number }} [options]
 * @returns {Promise<OpenAIConversionResult>}
 */
export async function sendOpenAIConversion(args, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  if (env.OPENAI_CAPI_ENABLED !== "true") return { skipped: true, reason: "OpenAI CAPI disabled" };
  if (env.OUTBOUND_MODE === "mock")
    return { skipped: true, reason: "OpenAI CAPI mock; no event sent" };

  const enabledEvents = (env.OPENAI_CAPI_EVENTS ?? "TRIAL_BOOKED")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    !enabledEvents.length ||
    enabledEvents.some((name) => !["TRIAL_BOOKED", "APPOINTMENT_BOOKED"].includes(name))
  ) {
    return {
      skipped: true,
      reason: "Invalid OPENAI_CAPI_EVENTS; use TRIAL_BOOKED and/or APPOINTMENT_BOOKED",
    };
  }
  if (!enabledEvents.includes(args.eventName))
    return { skipped: true, reason: "No OpenAI booking mapping for canonical event" };

  const key = env.OPENAI_CAPI_API_KEY?.trim();
  const pixelId = env.OPENAI_CAPI_PIXEL_ID?.trim();
  if (!key || /\s/.test(key) || !pixelId || /\s/.test(pixelId)) {
    return { skipped: true, reason: "Missing/invalid OPENAI_CAPI_API_KEY or OPENAI_CAPI_PIXEL_ID" };
  }
  if (env.OPENAI_CAPI_VALIDATE_ONLY && !["true", "false"].includes(env.OPENAI_CAPI_VALIDATE_ONLY)) {
    return { skipped: true, reason: "OPENAI_CAPI_VALIDATE_ONLY must be true or false" };
  }
  const validateOnly = env.OPENAI_CAPI_VALIDATE_ONLY !== "false";
  const timestamp = args.eventTime.getTime();
  if (!Number.isFinite(timestamp) || timestamp < now - 7 * 86400_000 || timestamp > now + 600_000) {
    return {
      skipped: true,
      reason: "OpenAI event timestamp must be within 7 days and no more than 10 minutes ahead",
    };
  }
  if (!args.eventId.trim()) return { skipped: true, reason: "Missing stable appointment event ID" };
  const url = sourceUrl(args.eventSourceUrl);
  if (!url) return { skipped: true, reason: "Invalid Virtu event source URL" };

  const email = emailHash(args.email);
  const phone = phoneHash(args.phone, env.OPENAI_CAPI_DEFAULT_PHONE_COUNTRY_CODE?.trim());
  if (!email && !phone)
    return {
      skipped: true,
      reason: "No usable email or international phone identifier for OpenAI matching",
    };
  const user = {
    ...(email ? { emails_sha256: [email] } : {}),
    ...(phone ? { phone_numbers_sha256: [phone] } : {}),
    ...(args.ip && isIP(args.ip) ? { ip_address: args.ip } : {}),
    ...(args.userAgent?.trim() ? { user_agent: args.userAgent.trim() } : {}),
  };
  const payload = {
    validate_only: validateOnly,
    integration_source: "virtu_analytics_service",
    events: [
      {
        id: `acuity_booking_${args.eventId}`,
        type: "appointment_scheduled",
        timestamp_ms: timestamp,
        source_url: url,
        action_source: "web",
        opt_out: true,
        user,
        data: { type: "customer_action" },
      },
    ],
  };
  // Delivery diagnostics omit payload, identifiers (even hashes), URL, and credentials.
  const requestBody = JSON.stringify({
    event_type: "appointment_scheduled",
    timestamp_ms: timestamp,
    validate_only: validateOnly,
    matching_fields: Object.keys(user),
    event_count: 1,
  });
  const endpoint = new URL(ENDPOINT);
  endpoint.searchParams.set("pid", pixelId);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // The public CAPI guide does not define a success-body schema. Use HTTP status,
    // discard upstream content, and confirm received events in Ads Manager at activation.
    await response.body?.cancel();
    return {
      skipped: false,
      ok: response.ok,
      validated: validateOnly,
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      body: JSON.stringify({
        http_status: response.status,
        mode: validateOnly ? "validation_only" : "live",
        accepted: response.ok,
      }),
      requestBody,
    };
  } catch {
    return {
      skipped: false,
      ok: false,
      validated: validateOnly,
      retryable: true,
      status: 503,
      body: "OpenAI CAPI network/timeout/redirect failure",
      requestBody,
    };
  }
}
