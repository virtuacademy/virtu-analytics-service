import { NextRequest, NextResponse } from "next/server";
import { sendGoogleAdsClickConversion } from "@/lib/outbound/googleAds";

export const runtime = "nodejs";

function getTestSecret(req: NextRequest): string | null {
  const headerSecret =
    req.headers.get("x-google-ads-test-secret") ?? req.headers.get("x-test-secret") ?? req.headers.get("authorization");
  if (headerSecret) {
    if (headerSecret.toLowerCase().startsWith("bearer ")) {
      return headerSecret.slice("bearer ".length).trim();
    }
    return headerSecret.trim();
  }
  const url = new URL(req.url);
  return url.searchParams.get("secret");
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

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.GOOGLE_ADS_TEST_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Missing GOOGLE_ADS_TEST_SECRET" }, { status: 500 });
  }

  const provided = getTestSecret(req);
  if (!provided || provided !== secret) {
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

  const eventId = typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : `test-${Date.now()}`;
  const eventName = typeof body.eventName === "string" && body.eventName.trim() ? body.eventName.trim() : "TRIAL_BOOKED";
  const eventTimeValue = body.eventTime ?? body.conversionDateTime;
  const parsedEventTime = parseDate(eventTimeValue);
  if (eventTimeValue && !parsedEventTime) {
    return NextResponse.json({ ok: false, error: "Invalid eventTime/conversionDateTime" }, { status: 400 });
  }

  const result = await sendGoogleAdsClickConversion({
    eventId,
    eventName,
    eventTime: parsedEventTime ?? new Date(),
    conversionValue: parseNumber(body.conversionValue ?? body.value),
    currencyCode: typeof body.currencyCode === "string" ? body.currencyCode.trim() : undefined,
    gclid: typeof body.gclid === "string" ? body.gclid.trim() : undefined,
    gbraid: typeof body.gbraid === "string" ? body.gbraid.trim() : undefined,
    wbraid: typeof body.wbraid === "string" ? body.wbraid.trim() : undefined,
    email: typeof body.email === "string" ? body.email.trim() : undefined,
    phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
    firstName: typeof body.firstName === "string" ? body.firstName.trim() : undefined,
    lastName: typeof body.lastName === "string" ? body.lastName.trim() : undefined,
    orderId: typeof body.orderId === "string" ? body.orderId.trim() : undefined
  });

  if (result.skipped) {
    return NextResponse.json({ ok: false, skipped: true, reason: result.reason });
  }

  return NextResponse.json({ ok: result.ok, status: result.status, body: result.body });
}
