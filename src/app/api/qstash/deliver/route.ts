import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { prisma } from "@/lib/prisma";
import { sendMetaCapi } from "@/lib/outbound/meta";
import { submitHubSpotForm } from "@/lib/outbound/hubspot";
import { sendGoogleAdsClickConversion } from "@/lib/outbound/googleAds";
import { sendTikTokEvent } from "@/lib/outbound/tiktok";

export const runtime = "nodejs";

async function verifyQStash(req: NextRequest, body: string) {
  const signature = req.headers.get("upstash-signature") ?? req.headers.get("Upstash-Signature") ?? "";
  if (!signature) return false;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return false;

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  return receiver.verify({ signature, body });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  const okSig = await verifyQStash(req, raw);
  if (!okSig) return NextResponse.json({ ok: false, error: "Invalid QStash signature" }, { status: 401 });

  const { canonicalEventId } = JSON.parse(raw) as { canonicalEventId: string };

  const ce = await prisma.canonicalEvent.findUnique({
    where: { id: canonicalEventId },
    include: { deliveries: true }
  });
  if (!ce) return NextResponse.json({ ok: false, error: "Missing canonical event" }, { status: 404 });

  const appt = ce.appointmentId
    ? await prisma.appointment.findUnique({ where: { id: ce.appointmentId } })
    : null;

  const attrib = ce.attributionTok
    ? await prisma.attribution.findUnique({ where: { token: ce.attributionTok } })
    : null;

  const session = attrib?.sessionId
    ? await prisma.session.findUnique({ where: { id: attrib.sessionId } })
    : null;

  const eventSourceUrl = attrib?.lastUrl ?? "https://virtu.academy";
  const email = appt?.email ?? null;
  const phone = appt?.phone ?? null;
  const ip = session?.ipFirst ?? null;
  const userAgent = session?.uaFirst ?? null;
  const mockOutbound = process.env.OUTBOUND_MODE === "mock";

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
          requestBody: patch.requestBody
        }
      });
    };

    try {
      if (d.platform === "META") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_meta" });
        } else {
          const metaEventName = ce.name === "TRIAL_BOOKED" ? "SubmitApplication" : "CustomEvent";
          const r = await sendMetaCapi({
            eventName: metaEventName,
            eventId: ce.eventId,
            eventTime: ce.eventTime,
            eventSourceUrl,
            ip,
            userAgent,
            email,
            phoneDigits: phone,
            fbc: appt?.fbc ?? attrib?.fbc ?? null,
            fbp: appt?.fbp ?? attrib?.fbp ?? null,
            customData: {
              appointment_id: ce.appointmentId,
              utm_campaign: attrib?.utmCampaign ?? null,
              utm_source: attrib?.utmSource ?? null
            }
          });

          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: String(r.reason) });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody
            });
          }
        }
      }

      if (d.platform === "HUBSPOT") {
        const portalId = process.env.HUBSPOT_PORTAL_ID!;
        const formGuid = process.env.HUBSPOT_TRIAL_FORM_GUID!;
        const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN!;
        if (!portalId || !formGuid || !token) {
          await mark({ status: "SKIPPED", responseBody: "Missing HubSpot env" });
        } else if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_hubspot" });
        } else {
          const r = await submitHubSpotForm({
            portalId,
            formGuid,
            accessToken: token,
            email,
            fields: {
              email: email ?? "",
              acuity_appointment_id: ce.appointmentId ?? "",
              va_attrib: ce.attributionTok ?? "",
              utm_source: attrib?.utmSource ?? "",
              utm_medium: attrib?.utmMedium ?? "",
              utm_campaign: attrib?.utmCampaign ?? "",
              gclid: appt?.gclid ?? attrib?.gclid ?? "",
              ttclid: appt?.ttclid ?? attrib?.ttclid ?? ""
            },
            hutk: attrib?.hubspotutk ?? null,
            pageUri: attrib?.lastUrl ?? null,
            pageName: null,
            ipAddress: ip
          });

          await mark({
            status: r.ok ? "SUCCESS" : "FAILED",
            responseCode: r.status,
            responseBody: r.body,
            requestBody: r.requestBody
          });
        }
      }

      if (d.platform === "GOOGLE_ADS") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_google_ads" });
        } else {
          const r = await sendGoogleAdsClickConversion({
            eventId: ce.eventId,
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
            userIpAddress: ip
          });
          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: r.reason });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody
            });
          }
        }
      }

      if (d.platform === "TIKTOK") {
        if (mockOutbound) {
          await mark({ status: "SUCCESS", responseBody: "mock_tiktok" });
        } else {
          const r = await sendTikTokEvent({
            eventId: ce.eventId,
            eventName: ce.name,
            eventTime: ce.eventTime,
            conversionValue: ce.value ?? null,
            currencyCode: ce.currency ?? null,
            ttclid: appt?.ttclid ?? attrib?.ttclid ?? null,
            email,
            phone,
            externalId: ce.attributionTok ?? null,
            userIpAddress: ip,
            userAgent: userAgent,
            pageUrl: eventSourceUrl,
            pageReferrer: attrib?.lastReferrer ?? null
          });

          if (r.skipped) {
            await mark({ status: "SKIPPED", responseBody: r.reason, requestBody: r.requestBody });
          } else {
            await mark({
              status: r.ok ? "SUCCESS" : "FAILED",
              responseCode: r.status,
              responseBody: r.body,
              requestBody: r.requestBody
            });
          }
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      await mark({ status: "FAILED", responseBody: message });
    }
  }

  return NextResponse.json({ ok: true });
}
