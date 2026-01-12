import { NextRequest, NextResponse } from "next/server";
import { sendMetaCapi } from "@/lib/outbound/meta";

export const runtime = "nodejs";

function getTestSecret(req: NextRequest): string | null {
  const headerSecret =
    req.headers.get("x-meta-test-secret") ??
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
  const secret = process.env.META_CAPI_TEST_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Missing META_CAPI_TEST_SECRET" },
      { status: 500 },
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
    return NextResponse.json({ ok: false, error: "Invalid eventTime" }, { status: 400 });
  }

  const eventSourceUrl =
    typeof body.eventSourceUrl === "string" && body.eventSourceUrl.trim()
      ? body.eventSourceUrl.trim()
      : "https://virtu.academy";

  const result = await sendMetaCapi({
    eventId,
    eventName,
    eventTime: parsedEventTime ?? new Date(),
    eventSourceUrl,
    email: typeof body.email === "string" ? body.email.trim() : undefined,
    phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
    firstName: typeof body.firstName === "string" ? body.firstName.trim() : undefined,
    lastName: typeof body.lastName === "string" ? body.lastName.trim() : undefined,
    city: typeof body.city === "string" ? body.city.trim() : undefined,
    state: typeof body.state === "string" ? body.state.trim() : undefined,
    zipCode: typeof body.zipCode === "string" ? body.zipCode.trim() : undefined,
    country: typeof body.country === "string" ? body.country.trim() : undefined,
    ip: typeof body.ip === "string" ? body.ip.trim() : undefined,
    userAgent: typeof body.userAgent === "string" ? body.userAgent.trim() : undefined,
    fbc: typeof body.fbc === "string" ? body.fbc.trim() : undefined,
    fbp: typeof body.fbp === "string" ? body.fbp.trim() : undefined,
    externalId: typeof body.externalId === "string" ? body.externalId.trim() : undefined,
    value: parseNumber(body.value),
    currency: typeof body.currency === "string" ? body.currency.trim() : undefined,
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
