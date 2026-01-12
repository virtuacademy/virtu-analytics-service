import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sha256Base64, sha256Hex } from "@/lib/crypto";
import { fetchAppointmentById, appointmentSnapshot, extractIntakeValue } from "@/lib/acuity";
import { enqueueDelivery } from "@/lib/qstash";

export const runtime = "nodejs";

async function forwardLegacyWebhook(opts: {
  url: string;
  raw: string;
  contentType: string;
  signature?: string;
}) {
  const headers: Record<string, string> = { "content-type": opts.contentType };
  if (opts.signature) headers["x-acuity-signature"] = opts.signature;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers,
      body: opts.raw,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("Legacy webhook forward failed", {
        status: res.status,
        statusText: res.statusText,
      });
    }
  } catch (err) {
    console.warn("Legacy webhook forward error", err);
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.ACUITY_API_KEY;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Missing ACUITY_API_KEY" }, { status: 500 });
  }

  const sig = req.headers.get("x-acuity-signature") ?? "";
  const raw = await req.text();
  const contentType = req.headers.get("content-type") ?? "application/x-www-form-urlencoded";

  const expected = sha256Base64(raw, secret as string);
  if (!sig || sig !== expected) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  const bodyHash = sha256Hex(raw);
  const form = new URLSearchParams(raw);
  const action = form.get("action") ?? "unknown";
  const externalId = form.get("id") ?? "";
  const appointmentTypeID = form.get("appointmentTypeID");
  const calendarID = form.get("calendarID");

  if (!externalId) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });

  const legacyUrl = process.env.ACUITY_WEBHOOK_FORWARD_URL;
  if (legacyUrl) {
    await forwardLegacyWebhook({
      url: legacyUrl,
      raw,
      contentType,
      signature: sig || undefined,
    });
  }

  try {
    await prisma.inboundWebhook.create({
      data: {
        source: "acuity",
        action,
        externalId,
        bodyRaw: raw,
        bodyHash,
      },
    });
  } catch {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const appt = await fetchAppointmentById(externalId);

  const VA_ATTRIB_FIELD_ID = Number(process.env.ACUITY_FIELD_VA_ATTRIB_ID || "0") || null;
  const GCLID_FIELD_ID = Number(process.env.ACUITY_FIELD_GCLID_ID || "0") || null;
  const TTCLID_FIELD_ID = Number(process.env.ACUITY_FIELD_TTCLID_ID || "0") || null;
  const FBP_FIELD_ID = Number(process.env.ACUITY_FIELD_FBP_ID || "0") || null;
  const FBC_FIELD_ID = Number(process.env.ACUITY_FIELD_FBC_ID || "0") || null;

  const vaAttrib = VA_ATTRIB_FIELD_ID ? extractIntakeValue(appt, VA_ATTRIB_FIELD_ID) : null;
  const gclid = GCLID_FIELD_ID ? extractIntakeValue(appt, GCLID_FIELD_ID) : null;
  const ttclid = TTCLID_FIELD_ID ? extractIntakeValue(appt, TTCLID_FIELD_ID) : null;
  const fbp = FBP_FIELD_ID ? extractIntakeValue(appt, FBP_FIELD_ID) : null;
  const fbc = FBC_FIELD_ID ? extractIntakeValue(appt, FBC_FIELD_ID) : null;

  const snap = appointmentSnapshot(appt);

  await prisma.appointment.upsert({
    where: { id: String(appt.id) },
    update: {
      appointmentTypeId: snap.appointmentTypeId,
      calendarId: snap.calendarId ?? calendarID ?? null,
      status: snap.status,
      datetime: snap.datetime,
      email: snap.email,
      phone: snap.phone,
      firstName: snap.firstName,
      lastName: snap.lastName,
      scheduledBy: snap.scheduledBy,
      vaAttrib,
      gclid,
      ttclid,
      fbp,
      fbc,
      rawJson: JSON.stringify(appt),
    },
    create: {
      id: String(appt.id),
      appointmentTypeId: snap.appointmentTypeId ?? appointmentTypeID ?? null,
      calendarId: snap.calendarId ?? calendarID ?? null,
      status: snap.status,
      datetime: snap.datetime,
      email: snap.email,
      phone: snap.phone,
      firstName: snap.firstName,
      lastName: snap.lastName,
      scheduledBy: snap.scheduledBy,
      vaAttrib,
      gclid,
      ttclid,
      fbp,
      fbc,
      rawJson: JSON.stringify(appt),
    },
  });

  const trialTypeIdsRaw =
    process.env.ACUITY_TRIAL_APPOINTMENT_TYPE_IDS ??
    process.env.ACUITY_TRIAL_APPOINTMENT_TYPE_ID ??
    "";
  const trialTypeIds = trialTypeIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const apptTypeId =
    appt.appointmentTypeID != null
      ? String(appt.appointmentTypeID)
      : appointmentTypeID
        ? String(appointmentTypeID)
        : "";
  const isTrial = trialTypeIds.length > 0 && trialTypeIds.includes(apptTypeId);

  let eventName: "TRIAL_BOOKED" | "TRIAL_RESCHEDULED" | "TRIAL_CANCELED" | "APPOINTMENT_UPDATED" =
    "APPOINTMENT_UPDATED";
  if (isTrial) {
    if (appt.canceled || action === "canceled") eventName = "TRIAL_CANCELED";
    else if (action === "rescheduled") eventName = "TRIAL_RESCHEDULED";
    else if (action === "scheduled") eventName = "TRIAL_BOOKED";
    else eventName = "TRIAL_BOOKED";
  }

  const eventId = String(appt.id);

  const ce = await prisma.canonicalEvent.create({
    data: {
      name: eventName,
      eventTime: new Date(),
      appointmentId: String(appt.id),
      attributionTok: vaAttrib ?? null,
      value: null,
      currency: "USD",
      eventId,
    },
  });

  await prisma.delivery.createMany({
    data: [
      { canonicalEventId: ce.id, platform: "META" },
      { canonicalEventId: ce.id, platform: "HUBSPOT" },
      { canonicalEventId: ce.id, platform: "GOOGLE_ADS" },
      { canonicalEventId: ce.id, platform: "TIKTOK" },
    ],
    skipDuplicates: true,
  });

  await enqueueDelivery(ce.id);

  return NextResponse.json({ ok: true, canonicalEventId: ce.id, eventName, vaAttrib, eventId });
}
