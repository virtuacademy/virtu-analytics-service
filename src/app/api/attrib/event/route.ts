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
import { enqueueDelivery } from "@/lib/qstash";

// A page reports what a visitor did on it (today: asked for a callback on the trial page), so
// ad platforms can count it.
//
// Nothing here can prove a person sent the request: anyone can call this, a script can send
// any Origin header, and anyone can get a visit token by loading the page. So the rules below
// do not try to tell people from scripts. They limit what one visit and one address can have
// accepted, write nothing for a request they refuse, and log a line when the day's volume
// looks wrong. No rule lets one caller's traffic stop another visitor's event: the way to stop
// a flood is to take the platforms out of PAGE_DELIVERY_PLATFORMS.
// Contract: docs/page-events.md.

export const runtime = "nodejs";

const MAX_BODY_CHARACTERS = 2048;
// The window every rule below counts in.
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Page events one address may have accepted in that window.
const DEFAULT_DAILY_LIMIT_PER_IP = 3;
// Accepted page events in that window, from everyone, beyond which an error is logged. Real
// volume is a handful a week.
const DEFAULT_DAILY_ALERT_THRESHOLD = 25;

const EVENT_NAMES = { "callback.requested": "CALLBACK_REQUESTED" } as const;
const PAGE_EVENT_NAMES = Object.values(EVENT_NAMES);

// Whether a string holds a control character (a NUL above all, which PostgreSQL refuses to
// store) or half of a surrogate pair. No name, email or phone number does, and letting one
// through would fail only inside the transaction, after the locks are taken and with nothing
// recorded for the rules to count.
function isUnstorableText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Optional values may be null, blank or omitted; all are stored as null.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null)
    .refine((value) => value === null || !isUnstorableText(value));

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

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_MS);
  // The caller's address as ingest takes it, counted per IPv4 address and per IPv6 /64.
  // Requests with no address share one allowance.
  const address = addressLimitKey(clientIp(req.headers));
  const limitPerIp = countSetting(
    process.env.PAGE_EVENT_DAILY_LIMIT_PER_IP,
    DEFAULT_DAILY_LIMIT_PER_IP,
  );

  // A request a rule refuses writes nothing, so a flood of them cannot fill the database, and
  // is answered like an accepted one. One log line says why, with nothing of the caller's.
  const refuse = (reason: string) => {
    console.warn(`[page-events] refused ${type}: ${reason}`);
    return answer({ ok: true });
  };
  // The two rules that depend on what was already accepted. An accepted event is one that
  // was recorded: refused ones leave no row to count.
  const refusalFor = async (db: Pick<typeof prisma, "eventContact">) => {
    const earlier = await db.eventContact.findFirst({
      where: { vaAttrib: attribTok, canonicalEvent: { name, eventTime: { gt: since } } },
      select: { canonicalEventId: true },
    });
    if (earlier) return "its visit already reported one in the last 24 hours";
    const fromThisAddress = await db.eventContact.count({
      where: { ipAddress: address, canonicalEvent: { name, eventTime: { gt: since } } },
    });
    if (fromThisAddress >= limitPerIp) {
      return `its address already had ${limitPerIp} accepted in the last 24 hours (PAGE_EVENT_DAILY_LIMIT_PER_IP)`;
    }
    return null;
  };

  type Outcome = { refusal: string } | { canonicalEventId: string; queue: boolean };
  let outcome: Outcome;
  try {
    // Only a visit this service recorded can report an event. Tokens of other events
    // (`opus_…`, `page_…`) are not UUIDs and never get this far.
    const visit = await prisma.attribution.findUnique({ where: { token: attribTok } });
    if (!visit) return answer({ ok: false, error: "Unknown visit" }, 404);

    // Every refusal is tried here first, before any lock is taken, so refused requests stay
    // cheap and never wait on each other.
    if (now.getTime() - visit.lastTouchAt.getTime() > WINDOW_MS) {
      return refuse("its visit was last seen more than 24 hours ago");
    }
    if (hasNothingToMatch(visit, contact)) {
      return refuse("it has no click ID and no email or phone to match it with");
    }
    const refusedEarly = await refusalFor(prisma);
    if (refusedEarly) return refuse(refusedEarly);

    const eventId = `${PAGE_EVENT_ID_PREFIX}callback_${randomId()}`;
    const value = configuredEventValue("page", name);
    const enabled = enabledDeliveryPlatforms(process.env.PAGE_DELIVERY_PLATFORMS);

    outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      // Requests for the same visit take turns, and so do requests from the same address, so
      // two at once cannot both pass a rule. The visit's lock always comes first, so two
      // requests can never wait on each other. Requests that share neither do not wait at
      // all: no caller can hold up another visitor. The locks end with the transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(731620, hashtext(${attribTok}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(731621, hashtext(${address ?? ""}))`;
      const refusal = await refusalFor(tx);
      if (refusal) return { refusal };

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

      const deliveries = AD_EVENT_DELIVERY_PLATFORMS.map((platform) =>
        enabled.has(platform)
          ? {
              canonicalEventId: canonicalEvent.id,
              platform,
              status: "PENDING" as const,
              responseBody: null,
            }
          : {
              canonicalEventId: canonicalEvent.id,
              platform,
              status: "SKIPPED" as const,
              responseBody: `Page delivery to ${platform} is off (not listed in PAGE_DELIVERY_PLATFORMS)`,
            },
      );
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

  if ("refusal" in outcome) return refuse(outcome.refusal);

  // An alarm, not a limit: this event is delivered like any other. A limit shared by everyone
  // would let a few forged requests a day stop every real callback, and a skipped delivery is
  // never sent later.
  const alertThreshold = countSetting(
    process.env.PAGE_EVENT_DAILY_ALERT_THRESHOLD,
    DEFAULT_DAILY_ALERT_THRESHOLD,
  );
  try {
    const accepted = await prisma.canonicalEvent.count({
      where: { name: { in: PAGE_EVENT_NAMES }, eventTime: { gt: since } },
    });
    if (accepted > alertThreshold) {
      console.error(
        `[page-events] ${accepted} page events in 24 hours, over PAGE_EVENT_DAILY_ALERT_THRESHOLD (${alertThreshold}). Still delivering. If this is a flood, remove the platforms from PAGE_DELIVERY_PLATFORMS.`,
      );
    }
  } catch {
    // The alarm must never cost the event.
  }

  if (outcome.queue) {
    try {
      await enqueueDelivery(outcome.canonicalEventId);
    } catch {
      // The page cannot do anything about it, and the event is recorded.
      console.error("Page event: queuing deliveries failed", {
        canonicalEventId: outcome.canonicalEventId,
      });
    }
  }

  return answer({ ok: true });
}
