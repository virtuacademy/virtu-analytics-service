import { NextRequest, NextResponse } from "next/server";
import { sendTikTokEvent } from "@/lib/outbound/tiktok";

export const runtime = "nodejs";

/**
 * TikTok Events API Test Endpoint
 *
 * This endpoint allows manual testing of the TikTok Events API integration.
 * It mirrors the structure of /api/test/google-ads for consistency.
 *
 * Authentication:
 *   Set TIKTOK_TEST_SECRET in your environment, then provide it via:
 *   - Header: Authorization: Bearer <secret>
 *   - Header: x-tiktok-test-secret: <secret>
 *   - Header: x-test-secret: <secret>
 *   - Query param: ?secret=<secret>
 *
 * Example request:
 *   POST /api/test/tiktok
 *   Authorization: Bearer your-test-secret
 *   Content-Type: application/json
 *
 *   {
 *     "eventId": "test-123",
 *     "eventName": "TRIAL_BOOKED",
 *     "eventTime": "2026-01-10T12:00:00Z",
 *     "ttclid": "your-ttclid-here",
 *     "email": "test@example.com",
 *     "phone": "+14155551234",
 *     "pageUrl": "https://virtu.academy/schedule"
 *   }
 */

function getTestSecret(req: NextRequest): string | null {
  const headerSecret =
    req.headers.get("x-tiktok-test-secret") ??
    req.headers.get("x-test-secret") ??
    req.headers.get("authorization");

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
  const secret = process.env.TIKTOK_TEST_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Missing TIKTOK_TEST_SECRET env var" },
      { status: 500 }
    );
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

  // Parse request body with sensible defaults
  const eventId =
    typeof body.eventId === "string" && body.eventId.trim()
      ? body.eventId.trim()
      : `test-${Date.now()}`;

  const eventName =
    typeof body.eventName === "string" && body.eventName.trim()
      ? body.eventName.trim()
      : "TRIAL_BOOKED";

  const eventTimeValue = body.eventTime;
  const parsedEventTime = parseDate(eventTimeValue);
  if (eventTimeValue && !parsedEventTime) {
    return NextResponse.json({ ok: false, error: "Invalid eventTime format" }, { status: 400 });
  }

  const result = await sendTikTokEvent({
    eventId,
    eventName,
    eventTime: parsedEventTime ?? new Date(),
    conversionValue: parseNumber(body.conversionValue ?? body.value),
    currencyCode: typeof body.currencyCode === "string" ? body.currencyCode.trim() : undefined,
    ttclid: typeof body.ttclid === "string" ? body.ttclid.trim() : undefined,
    ttp: typeof body.ttp === "string" ? body.ttp.trim() : undefined,
    email: typeof body.email === "string" ? body.email.trim() : undefined,
    phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
    externalId: typeof body.externalId === "string" ? body.externalId.trim() : undefined,
    userIpAddress: typeof body.userIpAddress === "string" ? body.userIpAddress.trim() : undefined,
    userAgent: typeof body.userAgent === "string" ? body.userAgent.trim() : undefined,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.trim() : undefined,
    pageReferrer: typeof body.pageReferrer === "string" ? body.pageReferrer.trim() : undefined
  });

  if (result.skipped) {
    return NextResponse.json({
      ok: false,
      skipped: true,
      reason: result.reason,
      requestBody: result.requestBody
    });
  }

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    body: result.body,
    requestBody: result.requestBody
  });
}
