import { NextRequest, NextResponse } from "next/server";
import { sendHubSpotEvent } from "@/lib/outbound/hubspot";
import { timingSafeEqual } from "@/lib/auth";

export const runtime = "nodejs";

function getTestSecret(req: NextRequest): string | null {
  const headerSecret =
    req.headers.get("x-hubspot-test-secret") ??
    req.headers.get("x-test-secret") ??
    req.headers.get("authorization");
  if (headerSecret) {
    if (headerSecret.toLowerCase().startsWith("bearer ")) {
      return headerSecret.slice("bearer ".length).trim();
    }
    return headerSecret.trim();
  }
  return null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function readString(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const secret = process.env.HUBSPOT_TEST_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Missing HUBSPOT_TEST_SECRET" }, { status: 500 });
  }

  const provided = getTestSecret(req);
  if (!provided || !timingSafeEqual(provided, secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const eventId =
    typeof body.eventId === "string" && body.eventId.trim()
      ? body.eventId.trim()
      : `test-${Date.now()}`;
  const eventName =
    typeof body.eventName === "string" && body.eventName.trim()
      ? body.eventName.trim()
      : "TRIAL_BOOKED";
  const parsedEventTime = parseDate(body.eventTime);
  if (body.eventTime && !parsedEventTime) {
    return NextResponse.json({ ok: false, error: "Invalid eventTime" }, { status: 400 });
  }

  const result = await sendHubSpotEvent({
    eventId,
    canonicalEventName: eventName,
    eventTime: parsedEventTime ?? new Date(),
    email: readString(body, "email"),
    utk: readString(body, "utk", "hubspotutk", "hutk"),
    pageUrl: readString(body, "pageUrl", "pageUri"),
    referrer: readString(body, "referrer"),
    userAgent: readString(body, "userAgent"),
    utmSource: readString(body, "utmSource", "utm_source"),
    utmMedium: readString(body, "utmMedium", "utm_medium"),
    utmCampaign: readString(body, "utmCampaign", "utm_campaign"),
    utmTerm: readString(body, "utmTerm", "utm_term"),
    utmContent: readString(body, "utmContent", "utm_content"),
    sourceSystem: readString(body, "sourceSystem") ?? process.env.HUBSPOT_SOURCE_SYSTEM,
  });

  if (result.skipped) {
    return NextResponse.json({ ok: false, skipped: true, reason: result.reason });
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(result.body);
  } catch {
    parsedBody = result.body;
  }

  return NextResponse.json({ ok: result.ok, status: result.status, body: parsedBody });
}
