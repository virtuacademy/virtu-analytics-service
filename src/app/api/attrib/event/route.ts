import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { randomId } from "@/lib/crypto";
import { isAllowedOrigin, withCors } from "@/lib/cors";
import { addressLimitKey, clientIp } from "@/lib/clientIp";
import { INGEST_ID_PATTERN } from "@/lib/attribToken";
import {
  AD_EVENT_DELIVERY_PLATFORMS,
  PAGE_EVENT_ID_PREFIX,
  enabledDeliveryPlatforms,
} from "@/lib/bookingSource";
import { configuredEventValue, hasNothingToMatch } from "@/lib/adEvents";
import { googleAdsNotBefore } from "@/lib/googleAdsHold";
import { queueDeliveries } from "@/lib/qstash";

// A page reports what a visitor did on it (today: asked for a callback on the trial page), so
// ad platforms can count it.
//
// Nothing here can prove a person sent the request: anyone can call this, a script can send
// any Origin header, and anyone can get a visit token by loading the page. So the rules below
// do not try to tell people from scripts. They limit what one visit and one address can have
// delivered, record every refused event with its reason, and log a line when the day's volume
// looks wrong. No rule lets one caller's traffic stop another visitor's event: the way to stop
// a flood is to take the platforms out of PAGE_DELIVERY_PLATFORMS.
// Contract: docs/page-events.md.

export const runtime = "nodejs";

const MAX_BODY_CHARACTERS = 2048;
// The window every rule below counts in.
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Page events one address may have delivered in that window.
const DEFAULT_DAILY_LIMIT_PER_IP = 3;
// Page events in that window, from everyone, beyond which an error is logged. Real volume is a
// handful a week.
const DEFAULT_DAILY_ALERT_THRESHOLD = 25;

const EVENT_NAMES = { "callback.requested": "CALLBACK_REQUESTED" } as const;
const PAGE_EVENT_NAMES = Object.values(EVENT_NAMES);

// Optional values may be null, blank or omitted; all are stored as null.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

const bodySchema = z.object({
  type: z.literal("callback.requested"),
  attribTok: z.string().regex(INGEST_ID_PATTERN),
  contact: z
    .object({ email: text(254), phone: text(40), firstName: text(100) })
    .nullish()
    .transform((contact) => contact ?? { email: null, phone: null, firstName: null }),
});

// A whole number of events from a setting; unset or unreadable means the default.
function countSetting(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  const count = trimmed ? Number(trimmed) : Number.NaN;
  return Number.isInteger(count) && count >= 0 ? count : fallback;
}

export async function OPTIONS(req: NextRequest) {
  return withCors(NextResponse.json({ ok: true }), req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Answers never repeat anything the caller sent, and say no more than which rule refused.
  const answer = (body: { ok: boolean; error?: string }, status = 200) =>
    withCors(NextResponse.json(body, { status }), origin);

  // Not a protection: it only keeps honest browsers on other sites out.
  if (!isAllowedOrigin(origin)) return answer({ ok: false, error: "Origin not allowed" }, 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARACTERS) return answer({ ok: false, error: "Body too large" }, 413);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return answer({ ok: false, error: "Invalid JSON" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return answer({ ok: false, error: "Invalid body" }, 400);
  const { type, attribTok, contact } = parsed.data;
  const name = EVENT_NAMES[type];

  // Only a visit this service recorded can report an event. Tokens of other events
  // (`opus_…`, `page_…`) are not UUIDs and never get this far.
  const visit = await prisma.attribution.findUnique({ where: { token: attribTok } });
  if (!visit) return answer({ ok: false, error: "Unknown visit" }, 404);

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_MS);
  // The caller's address as ingest takes it, counted per IPv4 address and per IPv6 /64.
  // Requests with no address share one allowance.
  const address = addressLimitKey(clientIp(req.headers));
  const limitPerIp = countSetting(
    process.env.PAGE_EVENT_DAILY_LIMIT_PER_IP,
    DEFAULT_DAILY_LIMIT_PER_IP,
  );
  const eventId = `${PAGE_EVENT_ID_PREFIX}callback_${randomId()}`;
  const value = configuredEventValue("page", name);
  const enabled = enabledDeliveryPlatforms(process.env.PAGE_DELIVERY_PLATFORMS);
  const googleNotBefore = googleAdsNotBefore(visit.lastTouchAt, now, now);

  let recorded: { canonicalEventId: string; queue: boolean; recordedInWindow: number };
  try {
    recorded = await prisma.$transaction(async (tx) => {
      // Page events are checked and recorded one at a time, so no two requests can both slip
      // under a limit. The lock ends with the transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7316201120)`;

      const earlier = await tx.eventContact.findFirst({
        where: { vaAttrib: attribTok, canonicalEvent: { name, eventTime: { gt: since } } },
        select: { canonicalEventId: true },
      });
      // This address's events that were accepted for delivery: a refused one does not count.
      const fromThisAddress = await tx.eventContact.count({
        where: {
          ipAddress: address,
          canonicalEvent: {
            name,
            eventTime: { gt: since },
            deliveries: { some: { status: { not: "SKIPPED" } } },
          },
        },
      });
      const fromEveryone = await tx.canonicalEvent.count({
        where: { name: { in: PAGE_EVENT_NAMES }, eventTime: { gt: since } },
      });

      // Why this event is recorded but delivered nowhere, if it is. Each reason is about
      // this visit or this address; nothing other visitors do can refuse an event.
      let refusal: string | null = null;
      if (earlier) {
        refusal = "Duplicate: this visit already reported this event in the last 24 hours";
      } else if (now.getTime() - visit.lastTouchAt.getTime() > WINDOW_MS) {
        refusal = "Stale visit: it was last seen more than 24 hours ago";
      } else if (hasNothingToMatch(visit, contact)) {
        refusal = "No click ID and no contact details to match this event with";
      } else if (fromThisAddress >= limitPerIp) {
        refusal = `Limit reached: ${limitPerIp} delivered page events from one address in 24 hours (PAGE_EVENT_DAILY_LIMIT_PER_IP)`;
      }

      // The visit frozen as it stands now, so later page views cannot change this conversion.
      await tx.attribution.create({ data: { ...visit, token: eventId, createdAt: undefined } });

      const canonicalEvent = await tx.canonicalEvent.create({
        data: {
          name,
          eventTime: now,
          attributionTok: eventId,
          value,
          currency: value == null ? null : "USD",
          eventId,
        },
      });

      await tx.eventContact.create({
        data: {
          canonicalEventId: canonicalEvent.id,
          email: contact.email,
          phone: contact.phone,
          firstName: contact.firstName,
          vaAttrib: attribTok,
          ipAddress: address,
        },
      });

      const deliveries = AD_EVENT_DELIVERY_PLATFORMS.map((platform) => {
        const skipped = (responseBody: string) => ({
          canonicalEventId: canonicalEvent.id,
          platform,
          status: "SKIPPED" as const,
          responseBody,
          notBefore: null,
        });
        if (!enabled.has(platform)) {
          return skipped(
            `Page delivery to ${platform} is off (not listed in PAGE_DELIVERY_PLATFORMS)`,
          );
        }
        if (refusal) return skipped(refusal);
        return {
          canonicalEventId: canonicalEvent.id,
          platform,
          status: "PENDING" as const,
          responseBody: null,
          // Google rejects an upload for a click under six hours old (see googleAdsHold).
          notBefore: platform === "GOOGLE_ADS" ? googleNotBefore : null,
        };
      });
      await tx.delivery.createMany({ data: deliveries });

      return {
        canonicalEventId: canonicalEvent.id,
        queue: deliveries.some((delivery) => delivery.status === "PENDING"),
        recordedInWindow: fromEveryone + 1,
      };
    });
  } catch (error) {
    console.error("Page event: database error", {
      code: (error as { code?: unknown })?.code ?? null,
    });
    return answer({ ok: false, error: "Database error" }, 500);
  }

  // An alarm, not a limit: this event is delivered like any other. A shared limit would let a
  // few forged requests a day stop every real callback, and a skipped delivery is never sent
  // later.
  const alertThreshold = countSetting(
    process.env.PAGE_EVENT_DAILY_ALERT_THRESHOLD,
    DEFAULT_DAILY_ALERT_THRESHOLD,
  );
  if (recorded.recordedInWindow > alertThreshold) {
    console.error(
      `[page-events] ${recorded.recordedInWindow} page events in 24 hours, over PAGE_EVENT_DAILY_ALERT_THRESHOLD (${alertThreshold}). Still delivering. If this is a flood, remove the platforms from PAGE_DELIVERY_PLATFORMS.`,
    );
  }

  if (recorded.queue) {
    try {
      await queueDeliveries(recorded.canonicalEventId);
    } catch {
      // The page cannot do anything about it, and the event is recorded.
      console.error("Page event: queuing deliveries failed", {
        canonicalEventId: recorded.canonicalEventId,
      });
    }
  }

  return answer({ ok: true });
}
