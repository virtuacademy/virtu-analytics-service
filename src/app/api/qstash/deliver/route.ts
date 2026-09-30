import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { prisma } from "@/lib/prisma";
import { sendMetaCapi } from "@/lib/outbound/meta";
import { sendHubSpotEvent } from "@/lib/outbound/hubspot";
import { sendGoogleAdsClickConversion } from "@/lib/outbound/googleAds";
import { sendTikTokEvent } from "@/lib/outbound/tiktok";
import { sendOpenAIConversion, validateOpenAIConversion } from "@/lib/outbound/openai.mjs";

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

  const canonicalEventId = message.canonicalEventId;
  if (
    typeof canonicalEventId !== "string" ||
    !canonicalEventId.trim() ||
    message.kind !== undefined
  ) {
    return NextResponse.json({ ok: false, error: "Invalid delivery message" }, { status: 400 });
  }

  const ce = await prisma.canonicalEvent.findUnique({
    where: { id: canonicalEventId },
    include: { deliveries: true },
  });
  if (!ce)
    return NextResponse.json({ ok: false, error: "Missing canonical event" }, { status: 404 });

  const appt = ce.appointmentId
    ? await prisma.appointment.findUnique({ where: { id: ce.appointmentId } })
    : null;
  const scheduledBy = appt?.scheduledBy?.trim() ?? "";

  if (scheduledBy) {
    for (const d of ce.deliveries) {
      if (d.status === "SUCCESS" || d.status === "SKIPPED") continue;

      await prisma.delivery.update({
        where: { id: d.id },
        data: {
          status: "SKIPPED",
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          responseBody: `Skipped outbound: appointment scheduled by logged-in Acuity user (${scheduledBy})`,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      skippedOutbound: true,
      skipReason: "scheduled_by_acuity_user",
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
  const email = appt?.email ?? null;
  const phone = appt?.phone ?? null;
  const ip = session?.ipFirst ?? null;
  const userAgent = session?.uaFirst ?? null;
  const mockOutbound = process.env.OUTBOUND_MODE === "mock";
  let retryOpenAI = false;

  for (const d of ce.deliveries) {
    if (d.status === "SUCCESS" || d.status === "SKIPPED") continue;

    const mark = async (patch: {
      status: "SUCCESS" | "FAILED" | "SKIPPED";
      responseCode?: number;
      responseBody?: string;
      requestBody?: string;
    }) => {
      await prisma.delivery.update({
        where: { id: d.id },
        data: {
          status: patch.status,
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          responseCode: patch.responseCode,
          responseBody: patch.responseBody,
          requestBody: patch.requestBody,
        },
      });
    };

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
          if (!r.ok && r.retryable) retryOpenAI = true;
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
            eventSourceUrl,
            email,
            phone,
            firstName: appt?.firstName ?? null,
            lastName: appt?.lastName ?? null,
            ip,
            userAgent,
            fbc: appt?.fbc ?? attrib?.fbc ?? null,
            fbp: appt?.fbp ?? attrib?.fbp ?? null,
            externalId: attrib?.token ?? null,
            value: ce.value ?? null,
            currency: ce.currency ?? null,
            customData: {
              appointment_id: ce.appointmentId,
              appointment_type_id: appt?.appointmentTypeId ?? null,
              utm_campaign: attrib?.utmCampaign ?? null,
              utm_source: attrib?.utmSource ?? null,
              utm_medium: attrib?.utmMedium ?? null,
            },
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
            sourceSystem: process.env.HUBSPOT_SOURCE_SYSTEM ?? "attrib.virtu.academy",
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
            gbraid: attrib?.gbraid ?? null,
            wbraid: attrib?.wbraid ?? null,
            email,
            phone,
            firstName: appt?.firstName ?? null,
            lastName: appt?.lastName ?? null,
            userIpAddress: ip,
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
      if (d.platform === "OPENAI") retryOpenAI = true;
      await mark({ status: "FAILED", responseBody: message });
    }
  }

  // QStash retries only unsuccessful HTTP responses. Completed platforms are skipped above.
  return NextResponse.json({ ok: !retryOpenAI }, { status: retryOpenAI ? 503 : 200 });
}
