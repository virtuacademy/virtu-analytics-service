import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { randomId } from "@/lib/crypto";
import { isAllowedOrigin, withCors } from "@/lib/cors";
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
// ad platforms can count it. Anyone can call this, so each rule below is there to keep it from
// minting conversions. Contract: docs/page-events.md.

export const runtime = "nodejs";

const MAX_BODY_CHARACTERS = 2048;
// One event of each type per visit in this window; later ones are recorded but not delivered.
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const EVENT_NAMES = { "callback.requested": "CALLBACK_REQUESTED" } as const;

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

export async function OPTIONS(req: NextRequest) {
  return withCors(NextResponse.json({ ok: true }), req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Answers never repeat anything the caller sent, and say no more than which rule refused.
  const answer = (body: { ok: boolean; error?: string }, status = 200) =>
    withCors(NextResponse.json(body, { status }), origin);

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
  const eventId = `${PAGE_EVENT_ID_PREFIX}callback_${randomId()}`;
  const value = configuredEventValue("page", name);
  const enabled = enabledDeliveryPlatforms(process.env.PAGE_DELIVERY_PLATFORMS);
  const googleNotBefore = googleAdsNotBefore(visit.lastTouchAt, now, now);

  let recorded: { canonicalEventId: string; queue: boolean };
  try {
    recorded = await prisma.$transaction(async (tx) => {
      // Requests for one visit take turns, so two cannot both pass the check below.
      await tx.$queryRaw`SELECT "token" FROM "Attribution" WHERE "token" = ${attribTok} FOR UPDATE`;
      const earlier = await tx.eventContact.findFirst({
        where: {
          vaAttrib: attribTok,
          canonicalEvent: {
            name,
            eventTime: { gt: new Date(now.getTime() - DUPLICATE_WINDOW_MS) },
          },
        },
        select: { canonicalEventId: true },
      });

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
        if (earlier) {
          return skipped("Duplicate: this visit already reported this event in the last 24 hours");
        }
        if (!enabled.has(platform)) {
          return skipped(
            `Page delivery to ${platform} is off (not listed in PAGE_DELIVERY_PLATFORMS)`,
          );
        }
        if (hasNothingToMatch(visit, contact)) {
          return skipped("No click ID and no contact details to match this event with");
        }
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
      };
    });
  } catch (error) {
    console.error("Page event: database error", {
      code: (error as { code?: unknown })?.code ?? null,
    });
    return answer({ ok: false, error: "Database error" }, 500);
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
