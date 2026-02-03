type HubSpotEventArgs = {
  eventId: string;
  canonicalEventName?: string | null;
  eventTime: Date;
  email?: string | null;
  utk?: string | null;
  pageUrl?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  sourceSystem?: string | null;
};

type HubSpotSendResult =
  | { skipped: true; reason: string }
  | { skipped: false; ok: boolean; status: number; body: string; requestBody: string };

function normalizeValue(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function extractEmailCandidate(value: string): string | null {
  const candidates = value
    .split(/[,\s;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return candidates.find((candidate) => candidate.includes("@")) ?? null;
}

function normalizeEmail(value?: string | null): string | null {
  if (!value) return null;
  const candidate = extractEmailCandidate(value);
  return candidate ? candidate.trim().toLowerCase() : null;
}

function parseEventNameMap(value?: string | null): Record<string, string> {
  if (!value) return {};
  const map: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [eventName, hubspotEvent] = pair.split("=").map((part) => part.trim());
    if (eventName && hubspotEvent) map[eventName] = hubspotEvent;
  }
  return map;
}

function resolveHubSpotEventName(canonicalEventName?: string | null): string | null {
  const mapping = parseEventNameMap(process.env.HUBSPOT_EVENT_NAMES);
  if (canonicalEventName && mapping[canonicalEventName]) {
    return mapping[canonicalEventName];
  }
  return null;
}

function compactProperties(
  properties: Record<string, string | number | null | undefined>,
): Record<string, string | number> {
  const compact: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    compact[key] = value;
  }
  return compact;
}

export async function sendHubSpotEvent(args: HubSpotEventArgs): Promise<HubSpotSendResult> {
  const accessToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!accessToken) {
    return { skipped: true, reason: "Missing env: HUBSPOT_PRIVATE_APP_TOKEN" };
  }

  const mappingRaw = process.env.HUBSPOT_EVENT_NAMES;
  if (!mappingRaw || !mappingRaw.trim()) {
    return { skipped: true, reason: "Missing env: HUBSPOT_EVENT_NAMES" };
  }

  const eventName = resolveHubSpotEventName(args.canonicalEventName);
  if (!eventName) {
    return {
      skipped: true,
      reason: `No HubSpot event mapping for ${args.canonicalEventName ?? "event"}`,
    };
  }

  const email = normalizeEmail(args.email);
  const utk = normalizeValue(args.utk);
  if (!email && !utk) {
    return { skipped: true, reason: "Missing email/utk for HubSpot event" };
  }

  const properties = compactProperties({
    event_id: args.eventId,
    source_system: normalizeValue(args.sourceSystem),
    hs_page_url: normalizeValue(args.pageUrl),
    hs_referrer: normalizeValue(args.referrer),
    hs_utm_source: normalizeValue(args.utmSource),
    hs_utm_medium: normalizeValue(args.utmMedium),
    hs_utm_campaign: normalizeValue(args.utmCampaign),
    hs_utm_term: normalizeValue(args.utmTerm),
    hs_utm_content: normalizeValue(args.utmContent),
    hs_user_agent: normalizeValue(args.userAgent),
  });

  const body: Record<string, unknown> = {
    eventName,
    occurredAt: args.eventTime.toISOString(),
    properties,
  };
  if (email) body.email = email;
  if (utk) body.utk = utk;
  const requestBody = JSON.stringify(body);

  const res = await fetch("https://api.hubapi.com/events/v3/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: requestBody,
    cache: "no-store",
  });

  const text = await res.text();
  return { skipped: false, ok: res.ok, status: res.status, body: text, requestBody };
}
