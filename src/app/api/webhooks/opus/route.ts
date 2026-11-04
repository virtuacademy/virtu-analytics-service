import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hmacSha256Hex, sha256Hex } from "@/lib/crypto";
import { timingSafeEqual } from "@/lib/auth";
import { enqueueDelivery } from "@/lib/qstash";
import { OPUS_DELIVERY_PLATFORMS, enabledOpusDeliveryPlatforms } from "@/lib/bookingSource";

// Opus (app.fortelessons.com) reports each booked trial lesson here.
// Contract: docs/opus-trial-webhook.md.

export const runtime = "nodejs";

const SIGNATURE_TOLERANCE_SECONDS = 300;
// A just-recorded event may already be queued with the worker not yet run, and the worker
// has no claim step, so a resend only requeues deliveries left unattempted this long.
const REQUEUE_AFTER_MS = 10 * 60 * 1000;
const STAFF_SCHEDULED_BY = "opus:staff";

const isoDateTime = z.string().datetime({ offset: true });
// Optional values may be null or omitted; both are stored as null.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value ?? null);
const shortText = () => text(512);
const longText = () => text(2048);

const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("trial.booked"),
    eventId: z.string().max(512),
    occurredAt: isoDateTime,
    booking: z.object({
      lessonId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      startsAt: isoDateTime,
      durationMinutes: z.number().int().positive().max(1440),
      instrument: shortText(),
      valueCents: z
        .number()
        .int()
        .nonnegative()
        .nullish()
        .transform((value) => value ?? null),
      currency: z.string().regex(/^[A-Z]{3}$/),
      invoicePaid: z.boolean(),
    }),
    contact: z.object({
      email: shortText(),
      phone: shortText(),
      firstName: shortText(),
      lastName: shortText(),
    }),
    client: z.object({
      ip: shortText(),
      userAgent: longText(),
    }),
    attribution: z.object({
      landingUrl: longText(),
      referrer: longText(),
      firstTouchAt: isoDateTime.nullish().transform((value) => value ?? null),
      lastTouchAt: isoDateTime.nullish().transform((value) => value ?? null),
      utm: z.object({
        source: shortText(),
        medium: shortText(),
        campaign: shortText(),
        term: shortText(),
        content: shortText(),
      }),
      click: z.object({
        gclid: shortText(),
        gbraid: shortText(),
        wbraid: shortText(),
        fbclid: shortText(),
        ttclid: shortText(),
        msclkid: shortText(),
      }),
    }),
    flags: z.object({ staffInitiated: z.boolean() }),
  })
  .refine((payload) => payload.eventId === `opus_${payload.booking.lessonId}`, {
    message: "eventId must be opus_<booking.lessonId>",
    path: ["eventId"],
  });

type TrialBookedPayload = z.infer<typeof payloadSchema>;

function verifySignature(
  raw: string,
  timestamp: string,
  signature: string,
  secret: string,
): string | null {
  if (!/^\d{1,12}$/.test(timestamp)) return "Invalid timestamp";
  const expected = `v1=${hmacSha256Hex(`${timestamp}.${raw}`, secret)}`;
  if (!signature || !timingSafeEqual(signature, expected)) return "Invalid signature";
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) return "Stale timestamp";
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function plannedDeliveries(payload: TrialBookedPayload) {
  // Staff bookings are recorded but never delivered, like staff-booked Acuity appointments.
  if (payload.flags.staffInitiated) return [];
  const enabled = enabledOpusDeliveryPlatforms(process.env.OPUS_DELIVERY_PLATFORMS);
  return OPUS_DELIVERY_PLATFORMS.map((platform) =>
    enabled.has(platform)
      ? { platform, status: "PENDING" as const, responseBody: null }
      : {
          platform,
          status: "SKIPPED" as const,
          responseBody: `Opus delivery to ${platform} is off (not listed in OPUS_DELIVERY_PLATFORMS)`,
        },
  );
}

async function record(raw: string, payload: TrialBookedPayload) {
  const { eventId, booking, contact, client, attribution, flags } = payload;
  const occurredAt = new Date(payload.occurredAt);
  const deliveries = plannedDeliveries(payload);

  return prisma.$transaction(async (tx) => {
    await tx.inboundWebhook.create({
      data: {
        source: "opus",
        action: "trial.booked",
        externalId: eventId,
        bodyRaw: raw,
        bodyHash: sha256Hex(raw),
      },
    });

    // The primary key makes the event ID the idempotency key: a resend with a
    // different body still collides here.
    await tx.appointment.create({
      data: {
        id: eventId,
        status: "scheduled",
        datetime: booking.startsAt,
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        lastName: contact.lastName,
        scheduledBy: flags.staffInitiated ? STAFF_SCHEDULED_BY : null,
        // Links the Attribution row below, as an Acuity va_attrib token does.
        vaAttrib: eventId,
        gclid: attribution.click.gclid,
        ttclid: attribution.click.ttclid,
        rawJson: raw,
      },
    });

    await tx.attribution.create({
      data: {
        token: eventId,
        firstTouchAt: attribution.firstTouchAt ? new Date(attribution.firstTouchAt) : occurredAt,
        lastTouchAt: attribution.lastTouchAt ? new Date(attribution.lastTouchAt) : occurredAt,
        firstUrl: attribution.landingUrl,
        lastUrl: attribution.landingUrl,
        firstReferrer: attribution.referrer,
        lastReferrer: attribution.referrer,
        ipAddress: client.ip,
        userAgent: client.userAgent,
        utmSource: attribution.utm.source,
        utmMedium: attribution.utm.medium,
        utmCampaign: attribution.utm.campaign,
        utmTerm: attribution.utm.term,
        utmContent: attribution.utm.content,
        gclid: attribution.click.gclid,
        gbraid: attribution.click.gbraid,
        wbraid: attribution.click.wbraid,
        fbclid: attribution.click.fbclid,
        ttclid: attribution.click.ttclid,
        msclkid: attribution.click.msclkid,
      },
    });

    const canonicalEvent = await tx.canonicalEvent.create({
      data: {
        name: "TRIAL_BOOKED",
        eventTime: occurredAt,
        appointmentId: eventId,
        attributionTok: eventId,
        value: booking.valueCents == null ? null : booking.valueCents / 100,
        currency: booking.currency,
        eventId,
      },
    });

    if (deliveries.length > 0) {
      await tx.delivery.createMany({
        data: deliveries.map((delivery) => ({
          canonicalEventId: canonicalEvent.id,
          ...delivery,
        })),
      });
    }

    return {
      canonicalEventId: canonicalEvent.id,
      queue: deliveries.some((delivery) => delivery.status === "PENDING"),
    };
  });
}

// A unique violation is a resend only when this booking's event already exists; anything
// else (for example an unrelated Attribution row with the same token) is a conflict.
// A resend writes nothing. Deliveries still unattempted after REQUEUE_AFTER_MS (the first
// request recorded the event but could not queue it) are queued again.
async function resolveDuplicate(
  eventId: string,
): Promise<{ duplicate: false } | { duplicate: true; requeued: boolean }> {
  const existing = await prisma.canonicalEvent.findFirst({
    where: { appointmentId: eventId, name: "TRIAL_BOOKED" },
    include: { deliveries: true },
  });
  if (!existing) return { duplicate: false };
  const stale = Date.now() - existing.createdAt.getTime() > REQUEUE_AFTER_MS;
  const unattempted = existing.deliveries.some(
    (delivery) => delivery.status === "PENDING" && delivery.attempts === 0,
  );
  if (!stale || !unattempted) return { duplicate: true, requeued: false };
  await enqueueDelivery(existing.id);
  return { duplicate: true, requeued: true };
}

export async function POST(req: NextRequest) {
  const secret = process.env.OPUS_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Missing OPUS_WEBHOOK_SECRET" }, { status: 500 });
  }

  const raw = await req.text();
  const signatureError = verifySignature(
    raw,
    req.headers.get("x-opus-timestamp") ?? "",
    req.headers.get("x-opus-signature") ?? "",
    secret,
  );
  if (signatureError) {
    return NextResponse.json({ ok: false, error: signatureError }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
  const payload = parsed.data;
  const { eventId } = payload;

  let recorded: { canonicalEventId: string; queue: boolean };
  try {
    recorded = await record(raw, payload);
  } catch (error) {
    if (isUniqueViolation(error)) {
      try {
        const outcome = await resolveDuplicate(eventId);
        if (!outcome.duplicate) {
          console.error("Opus webhook: conflicting record", { eventId });
          return NextResponse.json(
            { ok: false, eventId, error: "Conflicting record for this eventId" },
            { status: 409 },
          );
        }
        return NextResponse.json({ ok: true, eventId, deduped: true, requeued: outcome.requeued });
      } catch {
        console.error("Opus webhook: requeue failed", { eventId });
        return NextResponse.json(
          { ok: false, eventId, error: "Already recorded; queuing failed. Resend to retry." },
          { status: 500 },
        );
      }
    }
    console.error("Opus webhook: database error", {
      eventId,
      code: (error as { code?: unknown })?.code ?? null,
    });
    return NextResponse.json({ ok: false, eventId, error: "Database error" }, { status: 500 });
  }

  if (recorded.queue) {
    try {
      await enqueueDelivery(recorded.canonicalEventId);
    } catch {
      console.error("Opus webhook: queuing deliveries failed", { eventId });
      return NextResponse.json(
        { ok: false, eventId, recorded: true, error: "Recorded; queuing failed. Resend to retry." },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    eventId,
    canonicalEventId: recorded.canonicalEventId,
    queued: recorded.queue,
    ...(payload.flags.staffInitiated
      ? { skippedOutbound: true, skipReason: "opus_staff_booking" }
      : {}),
  });
}
