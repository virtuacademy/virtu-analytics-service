import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { prisma } from "@/lib/prisma";
import { sendMetaCapi } from "@/lib/outbound/meta";
import { sendHubSpotEvent } from "@/lib/outbound/hubspot";
import { sendGoogleAdsClickConversion } from "@/lib/outbound/googleAds";
import { sendTikTokEvent } from "@/lib/outbound/tiktok";
import { sendOpenAIConversion, validateOpenAIConversion } from "@/lib/outbound/openai.mjs";
import { bookingSourceFor, deliveryPlatformsSetting, isDeliveryEnabled } from "@/lib/bookingSource";
import { enqueuePlatformRetry } from "@/lib/qstash";

export const runtime = "nodejs";

async function verifyQStash(req: NextRequest, body: string) {
  const signature =
    req.headers.get("upstash-signature") ?? req.headers.get("Upstash-Signature") ?? "";
  if (!signature) return false;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return false;

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  try {
    return await receiver.verify({ signature, body });
  } catch {
    return false;
  }
}

// A rate limit or a server error can pass on a later try; any other failure would repeat.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Platforms whose temporary failures are retried through QStash. A thrown error (for example a
// network failure) counts as temporary too.
const RETRIED_PLATFORMS = new Set(["OPENAI", "GOOGLE_ADS", "HUBSPOT"]);

// Google refuses an upload while its click, or a newly created conversion action, is under six
// hours old (TOO_RECENT_EVENT, TOO_RECENT_CONVERSION_ACTION: "Retry after 6 hours have
// passed"). Uploads go at once all the same, because that refusal is rare. A delivery that
// does get it stays PENDING and is tried again by one later message that names Google Ads,
// this long after the refused attempt and at most this many times.
const TOO_RECENT_RETRY_DELAY_MS = 375 * 60 * 1000;
const TOO_RECENT_MAX_RETRIES = 4;
// The start of the responseBody of a delivery waiting for such a retry, followed by the
// retry's number ("TOO_RECENT_RETRY 2/4 …"). Only existing Delivery columns carry this state.
const TOO_RECENT_MARKER = "TOO_RECENT_RETRY ";
// Any other run for the event (a queue retry for another platform, a resend) leaves a waiting
// delivery alone until this long after its last attempt, so it cannot use up the retries. It
// is a little less than the delay, so the delivery's own message never comes too early by
// this server's clock.
const TOO_RECENT_WAIT_MS = TOO_RECENT_RETRY_DELAY_MS - 5 * 60 * 1000;

// How many too-recent retries a delivery has been given so far, read from its marker.
function tooRecentRetriesOf(responseBody: string | null): number {
  const match = responseBody?.match(/^TOO_RECENT_RETRY (\d+)\//);
  return match ? Number(match[1]) : 0;
}

// The marker to keep at the start of a delivery's responseBody when it fails for another
// reason (an outage, a rate limit, a thrown error), so the retries it has used are not
// forgotten and the next too-recent answer continues the count instead of starting over.
function tooRecentCountToKeep(responseBody: string | null): string {
  const retries = tooRecentRetriesOf(responseBody);
  return retries > 0 ? `${TOO_RECENT_MARKER}${retries}/${TOO_RECENT_MAX_RETRIES} used. ` : "";
}

function isWaitingForTooRecentRetry(delivery: {
  status: string;
  responseBody: string | null;
  lastAttemptAt: Date | null;
}): boolean {
  return (
    delivery.status === "PENDING" &&
    Boolean(delivery.responseBody?.startsWith(TOO_RECENT_MARKER)) &&
    delivery.lastAttemptAt !== null &&
    Date.now() - delivery.lastAttemptAt.getTime() < TOO_RECENT_WAIT_MS
  );
}

// A page address without its query string or fragment.
function originAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  const okSig = await verifyQStash(req, raw);
  if (!okSig)
    return NextResponse.json({ ok: false, error: "Invalid QStash signature" }, { status: 401 });

  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    message = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid delivery message" }, { status: 400 });
  }

  // A signed diagnostic message never reads a booking, writes delivery rows, or
  // invokes other providers. The helper always forces a synthetic validation-only event.
  if (message.kind === "openai_validation") {
    const validationId = message.validationId;
    if (
      typeof validationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        validationId,
      ) ||
      Object.keys(message).some((key) => !["kind", "validationId"].includes(key))
    ) {
      return NextResponse.json({ ok: false, error: "Invalid validation message" }, { status: 400 });
    }
    try {
      // Read-only probe verifies the production connection, table, and OPENAI enum.
      await prisma.delivery.findFirst({
        where: { id: `openai_validation_${validationId}`, platform: "OPENAI" },
        select: { id: true },
      });
    } catch {
      return NextResponse.json(
        { ok: false, validationOnly: true, validationId, stage: "database" },
        { status: 503 },
      );
    }
    try {
      const result = await validateOpenAIConversion(validationId);
      if (result.skipped) {
        return NextResponse.json(
          {
            ok: false,
            validationOnly: true,
            validationId,
            stage: "configuration",
            error: result.reason,
          },
          { status: 422 },
        );
      }
      const ok = result.ok && result.validated;
      const summary = {
        ok,
        validationOnly: true,
        validationId,
        database: "ok",
        openaiHttpStatus: result.status,
      };
      console.info("OpenAI backend validation", JSON.stringify(summary));
      return NextResponse.json(summary, { status: ok ? 200 : result.retryable ? 503 : 502 });
    } catch {
      return NextResponse.json(
        { ok: false, validationOnly: true, validationId, stage: "openai" },
        { status: 503 },
      );
    }
  }

  // A message names an event, and may name one platform: the later retry of an upload Google
  // refused as too recent. Such a run touches only that platform's deliveries, so it cannot
  // send another platform's failed delivery a second time (a HubSpot event has no idempotency
  // key). Nothing else is accepted.
  const canonicalEventId = message.canonicalEventId;
  const scope = message.platform;
  if (
    typeof canonicalEventId !== "string" ||
    !canonicalEventId.trim() ||
    (scope !== undefined && scope !== "GOOGLE_ADS") ||
    Object.keys(message).some((key) => key !== "canonicalEventId" && key !== "platform")
  ) {
    return NextResponse.json({ ok: false, error: "Invalid delivery message" }, { status: 400 });
  }

  const ce = await prisma.canonicalEvent.findUnique({
    where: { id: canonicalEventId },
    include: { deliveries: true },
  });
  if (!ce)
    return NextResponse.json({ ok: false, error: "Missing canonical event" }, { status: 404 });
  const deliveries = scope ? ce.deliveries.filter((d) => d.platform === scope) : ce.deliveries;

  const appt = ce.appointmentId
    ? await prisma.appointment.findUnique({ where: { id: ce.appointmentId } })
    : null;
  // A booking keeps its contact details on the appointment. Only an event with no appointment
  // (an account created, a callback requested) has an EventContact row, and only then is that
  // table read: delivering a booking must never depend on it.
  const eventContact = ce.appointmentId
    ? null
    : await prisma.eventContact.findUnique({ where: { canonicalEventId: ce.id } });
  const contact = appt ?? eventContact;
  const scheduledBy = appt?.scheduledBy?.trim() ?? "";
  const source = bookingSourceFor(ce.appointmentId ?? ce.eventId);

  if (scheduledBy || eventContact?.staffInitiated) {
    const staffBooking = !appt
      ? { reason: "created by Forte staff in Opus", skipReason: "created_by_opus_staff" }
      : source === "opus"
        ? { reason: "booked by Forte staff in Opus", skipReason: "scheduled_by_opus_staff" }
        : {
            reason: "appointment scheduled by logged-in Acuity user",
            skipReason: "scheduled_by_acuity_user",
          };
    for (const d of deliveries) {
      if (d.status === "SUCCESS" || d.status === "SKIPPED") continue;

      await prisma.delivery.update({
        where: { id: d.id },
        data: {
          status: "SKIPPED",
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          responseBody: `Skipped outbound: ${staffBooking.reason}${scheduledBy ? ` (${scheduledBy})` : ""}`,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      skippedOutbound: true,
      skipReason: staffBooking.skipReason,
      scheduledBy,
    });
  }

  const attrib = ce.attributionTok
    ? await prisma.attribution.findUnique({ where: { token: ce.attributionTok } })
    : null;

  const session = attrib?.sessionId
    ? await prisma.session.findUnique({ where: { id: attrib.sessionId } })
    : null;

  const eventSourceUrl = attrib?.lastUrl ?? "https://virtu.academy";
  const eventId = ce.appointmentId ?? ce.eventId;
  const email = contact?.email ?? null;
  const phone = contact?.phone ?? null;
  // An Opus or page event's own Attribution row carries an IP and user agent, for when it has
  // no ingest session or the session lacks one. Acuity sends keep using the session only.
  const ownAttrib = source === "acuity" ? null : attrib;
  const ip = session?.ipFirst ?? ownAttrib?.ipAddress ?? null;
  const userAgent = session?.uaFirst ?? ownAttrib?.userAgent ?? null;
  const mockOutbound = process.env.OUTBOUND_MODE === "mock";
  // Opus and page events may only reach the platforms their setting lists; Acuity has none.
  const platformsSetting = deliveryPlatformsSetting(source);
  let retry = false;

  for (const d of deliveries) {
    if (d.status === "SUCCESS" || d.status === "SKIPPED") continue;
    if (isWaitingForTooRecentRetry(d)) continue;

    const mark = async (patch: {
      status: "SUCCESS" | "FAILED" | "SKIPPED";
      responseCode?: number;
      responseBody?: string;
      requestBody?: string;
    }) => {
      // A failed delivery may be tried again, so it keeps its count of too-recent retries.
      const kept = patch.status === "FAILED" ? tooRecentCountToKeep(d.responseBody) : "";
      await prisma.delivery.update({
        where: { id: d.id },
        data: {
          status: patch.status,
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          responseCode: patch.responseCode,
          responseBody: kept ? `${kept}${patch.responseBody ?? ""}` : patch.responseBody,
          requestBody: patch.requestBody,
        },
      });
    };

    // Opus and page events may only reach the platforms enabled now, whatever rows exist.
    if (platformsSetting && !isDeliveryEnabled(d.platform, process.env[platformsSetting])) {
      const sourceName = source === "opus" ? "Opus" : "Page";
      await mark({
        status: "SKIPPED",
        responseBody: `${sourceName} delivery to ${d.platform} is off (not ${source === "opus" ? "an Opus" : "a page"} platform, or not listed in ${platformsSetting})`,
      });
      continue;
    }

    try {
      if (d.platform === "OPENAI") {
        const r = await sendOpenAIConversion({
          eventId,
          eventName: ce.name,
          eventTime: ce.eventTime,
          eventSourceUrl,
          email,
          phone,
          ip,
          userAgent,
        });
        if (r.skipped) {
          await mark({ status: "SKIPPED", responseBody: r.reason });
        } else {
          // A successful validation did not record a conversion.
          await mark({
            status: r.ok ? (r.validated ? "SKIPPED" : "SUCCESS") : "FAILED",
            responseCode: r.status,
            responseBody: r.body,
            requestBody: r.requestBody,
          });
          if (!r.ok && r.retryable) retry = true;
        }
      }

      if (d.platform === "META") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_meta" });
        } else {
          const r = await sendMetaCapi({
            eventId,
            eventName: ce.name,
            eventTime: ce.eventTime,
            // An Opus or page event's page address goes without its query string and fragment:
            // the click ID and UTMs travel in their own fields, and a landing link can carry
            // personal details. Acuity sends keep the address as stored.
            eventSourceUrl: source === "acuity" ? eventSourceUrl : originAndPath(eventSourceUrl),
            email,
            phone,
            firstName: contact?.firstName ?? null,
            lastName: contact?.lastName ?? null,
            ip,
            userAgent,
            fbc: appt?.fbc ?? attrib?.fbc ?? null,
            fbp: appt?.fbp ?? attrib?.fbp ?? null,
            externalId: attrib?.token ?? null,
            value: ce.value ?? null,
            currency: ce.currency ?? null,
            customData: {
              ...(ce.appointmentId
                ? {
                    appointment_id: ce.appointmentId,
                    appointment_type_id: appt?.appointmentTypeId ?? null,
                  }
                : {}),
              utm_campaign: attrib?.utmCampaign ?? null,
              utm_source: attrib?.utmSource ?? null,
              utm_medium: attrib?.utmMedium ?? null,
            },
            source,
          });

          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: String(r.reason) });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody,
            });
          }
        }
      }

      if (d.platform === "HUBSPOT") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_hubspot" });
        } else {
          const r = await sendHubSpotEvent({
            eventId: ce.eventId,
            canonicalEventName: ce.name,
            eventTime: ce.eventTime,
            email,
            utk: attrib?.hubspotutk ?? null,
            pageUrl: attrib?.lastUrl ?? null,
            referrer: attrib?.lastReferrer ?? null,
            userAgent: session?.uaFirst ?? attrib?.userAgent ?? null,
            utmSource: attrib?.utmSource ?? null,
            utmMedium: attrib?.utmMedium ?? null,
            utmCampaign: attrib?.utmCampaign ?? null,
            utmTerm: attrib?.utmTerm ?? null,
            utmContent: attrib?.utmContent ?? null,
            // HubSpot reports split Acuity and Opus trials on this property.
            sourceSystem:
              source === "opus"
                ? "opus"
                : (process.env.HUBSPOT_SOURCE_SYSTEM ?? "attrib.virtu.academy"),
          });

          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: r.reason });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody,
            });
            if (!r.ok && isTransientStatus(r.status)) retry = true;
          }
        }
      }

      if (d.platform === "GOOGLE_ADS") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_google_ads" });
        } else {
          const r = await sendGoogleAdsClickConversion({
            eventId,
            eventName: ce.name,
            eventTime: ce.eventTime,
            conversionValue: ce.value ?? null,
            currencyCode: ce.currency ?? null,
            gclid: appt?.gclid ?? attrib?.gclid ?? null,
            email,
            phone,
            firstName: contact?.firstName ?? null,
            lastName: contact?.lastName ?? null,
            userIpAddress: ip,
            source,
          });
          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: r.reason });
          } else if (!r.ok && r.tooRecent) {
            // Waiting is all this upload needs. Whatever happens here, the run is done with
            // it: the queue is not asked to retry this message.
            const retries = tooRecentRetriesOf(d.responseBody);
            const attemptedAt = new Date();
            const retryAt = new Date(attemptedAt.getTime() + TOO_RECENT_RETRY_DELAY_MS);
            let failure: string | null = null;
            if (retries >= TOO_RECENT_MAX_RETRIES) {
              failure = `Still too recent for Google after ${TOO_RECENT_MAX_RETRIES} retries.`;
            } else {
              try {
                await enqueuePlatformRetry(ce.id, "GOOGLE_ADS", retryAt);
              } catch {
                console.error(
                  "Delivery worker: could not queue the retry of a too-recent Google Ads upload",
                  { canonicalEventId: ce.id },
                );
                failure = "Too recent for Google, and its retry could not be queued.";
              }
            }
            if (failure) {
              await mark({
                status: "FAILED",
                responseCode: r.status,
                responseBody: `${failure} ${r.body}`,
                requestBody: r.requestBody,
              });
            } else {
              await prisma.delivery.update({
                where: { id: d.id },
                data: {
                  status: "PENDING",
                  attempts: { increment: 1 },
                  lastAttemptAt: attemptedAt,
                  responseCode: r.status,
                  responseBody: `${TOO_RECENT_MARKER}${retries + 1}/${TOO_RECENT_MAX_RETRIES} after ${retryAt.toISOString()}. ${r.body}`,
                  requestBody: r.requestBody,
                },
              });
            }
          } else {
            // A validate-only upload is checked by Google but records no conversion.
            const validatedOnly = r.ok && r.validateOnly;
            await mark({
              status: r.ok ? (validatedOnly ? "SKIPPED" : "SUCCESS") : "FAILED",
              responseCode: r.status,
              responseBody: validatedOnly
                ? `GOOGLE_ADS_VALIDATE_ONLY: Google checked this upload but recorded no conversion. ${r.body}`
                : r.body,
              requestBody: r.requestBody,
            });
            // A rejected conversion (for example an unknown gclid) comes back as HTTP 200 with a
            // partial failure, so only an outage or rate limit is retried.
            if (!r.ok && isTransientStatus(r.status)) retry = true;
          }
        }
      }

      if (d.platform === "TIKTOK") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_tiktok" });
        } else {
          const r = await sendTikTokEvent({
            eventId,
            eventName: ce.name,
            eventTime: ce.eventTime,
            conversionValue: ce.value ?? null,
            currencyCode: ce.currency ?? null,
            contentId: appt?.appointmentTypeId ?? null,
            contentType: appt?.appointmentTypeId ? "service" : null,
            price: ce.value ?? null,
            ttclid: appt?.ttclid ?? attrib?.ttclid ?? null,
            ttp: attrib?.ttp ?? null,
            email,
            phone,
            externalId: attrib?.token ?? null,
            userIpAddress: ip,
            userAgent,
            pageUrl: eventSourceUrl,
            pageReferrer: attrib?.lastReferrer ?? null,
          });

          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: r.reason, requestBody: r.requestBody });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody,
            });
          }
        }
      }
    } catch (e: unknown) {
      const message =
        d.platform === "OPENAI"
          ? "OpenAI delivery failed"
          : e instanceof Error
            ? e.message
            : "Unknown error";
      if (RETRIED_PLATFORMS.has(d.platform)) retry = true;
      await mark({ status: "FAILED", responseBody: message });
    }
  }

  // QStash retries only unsuccessful HTTP responses. A retry skips platforms that succeeded or
  // were skipped and tries every FAILED one again. Google dedupes on order_id and Meta and
  // TikTok on the event ID; a HubSpot event has no idempotency key, so a HubSpot 5xx that was in
  // fact recorded would be recorded twice.
  return NextResponse.json({ ok: !retry }, { status: retry ? 503 : 200 });
}
