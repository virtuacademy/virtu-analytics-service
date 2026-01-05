import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sha256Base64, sha256Hex } from "@/lib/crypto";
import type { AcuityAppointment } from "@/lib/acuity";
import { fetchAppointmentById, appointmentSnapshot, extractIntakeValue } from "@/lib/acuity";
import { enqueueDelivery } from "@/lib/qstash";

export const runtime = "nodejs";

type DevPayload = {
  [key: string]: unknown;
  action?: string;
  id?: string | number;
  appointmentTypeID?: string | number;
  calendarID?: string | number;
  appointment?: Record<string, unknown>;
  vaAttrib?: string | null;
  gclid?: string | null;
  ttclid?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export async function POST(req: NextRequest) {
  const devBypass =
    process.env.ACUITY_WEBHOOK_DEV_BYPASS === "1" && req.headers.get("x-acuity-dev") === "1";
  const secret = process.env.ACUITY_API_KEY;
  if (!devBypass && !secret) {
    return NextResponse.json({ ok: false, error: "Missing ACUITY_API_KEY" }, { status: 500 });
  }

  const sig = req.headers.get("x-acuity-signature") ?? "";
  const raw = await req.text();

  if (!devBypass) {
    const expected = sha256Base64(raw, secret as string);
    if (!sig || sig !== expected) {
      return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
    }
  }

  const bodyHash = sha256Hex(raw);
  let action = "unknown";
  let externalId = "";
  let appointmentTypeID: string | null = null;
  let calendarID: string | null = null;
  let devPayload: DevPayload | null = null;

  if (devBypass) {
    try {
      devPayload = JSON.parse(raw) as DevPayload;
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }
    action = String(devPayload?.action ?? "unknown");
    externalId = String(devPayload?.id ?? "");
    appointmentTypeID = devPayload?.appointmentTypeID
      ? String(devPayload?.appointmentTypeID)
      : null;
    calendarID = devPayload?.calendarID ? String(devPayload?.calendarID) : null;
  } else {
    const form = new URLSearchParams(raw);
    action = form.get("action") ?? "unknown";
    externalId = form.get("id") ?? "";
    appointmentTypeID = form.get("appointmentTypeID");
    calendarID = form.get("calendarID");
  }

  if (!externalId) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });

  try {
    await prisma.inboundWebhook.create({
      data: {
        source: "acuity",
        action,
        externalId,
        bodyRaw: raw,
        bodyHash
      }
    });
  } catch {
    return NextResponse.json({ ok: true, deduped: true });
  }

  const appt = devBypass
    ? ({
        id: Number(externalId),
        appointmentTypeID: appointmentTypeID ? Number(appointmentTypeID) : undefined,
        calendarID: calendarID ? Number(calendarID) : undefined,
        ...(devPayload?.appointment ?? devPayload)
      } as AcuityAppointment)
    : await fetchAppointmentById(externalId);

  const VA_ATTRIB_FIELD_ID = Number(process.env.ACUITY_FIELD_VA_ATTRIB_ID || "0") || null;
  const GCLID_FIELD_ID = Number(process.env.ACUITY_FIELD_GCLID_ID || "0") || null;
  const TTCLID_FIELD_ID = Number(process.env.ACUITY_FIELD_TTCLID_ID || "0") || null;
  const FBP_FIELD_ID = Number(process.env.ACUITY_FIELD_FBP_ID || "0") || null;
  const FBC_FIELD_ID = Number(process.env.ACUITY_FIELD_FBC_ID || "0") || null;

  const vaAttrib =
    devPayload?.vaAttrib ?? (VA_ATTRIB_FIELD_ID ? extractIntakeValue(appt, VA_ATTRIB_FIELD_ID) : null);
  const gclid = devPayload?.gclid ?? (GCLID_FIELD_ID ? extractIntakeValue(appt, GCLID_FIELD_ID) : null);
  const ttclid =
    devPayload?.ttclid ?? (TTCLID_FIELD_ID ? extractIntakeValue(appt, TTCLID_FIELD_ID) : null);
  const fbp = devPayload?.fbp ?? (FBP_FIELD_ID ? extractIntakeValue(appt, FBP_FIELD_ID) : null);
  const fbc = devPayload?.fbc ?? (FBC_FIELD_ID ? extractIntakeValue(appt, FBC_FIELD_ID) : null);

  const snap = appointmentSnapshot(appt);

  await prisma.appointment.upsert({
    where: { id: String(appt.id) },
    update: {
      appointmentTypeId: snap.appointmentTypeId,
      calendarId: snap.calendarId ?? (calendarID ?? null),
      status: snap.status,
      datetime: snap.datetime,
      email: snap.email,
      phone: snap.phone,
      firstName: snap.firstName,
      lastName: snap.lastName,
      vaAttrib,
      gclid,
      ttclid,
      fbp,
      fbc,
      rawJson: JSON.stringify(appt)
    },
    create: {
      id: String(appt.id),
      appointmentTypeId: snap.appointmentTypeId ?? (appointmentTypeID ?? null),
      calendarId: snap.calendarId ?? (calendarID ?? null),
      status: snap.status,
      datetime: snap.datetime,
      email: snap.email,
      phone: snap.phone,
      firstName: snap.firstName,
      lastName: snap.lastName,
      vaAttrib,
      gclid,
      ttclid,
      fbp,
      fbc,
      rawJson: JSON.stringify(appt)
    }
  });

  const TRIAL_TYPE_ID = process.env.ACUITY_TRIAL_APPOINTMENT_TYPE_ID;
  const isTrial = TRIAL_TYPE_ID && String(appt.appointmentTypeID ?? "") === String(TRIAL_TYPE_ID);

  let eventName: "TRIAL_BOOKED" | "TRIAL_RESCHEDULED" | "TRIAL_CANCELED" | "APPOINTMENT_UPDATED" = "APPOINTMENT_UPDATED";
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
      eventId
    }
  });

  await prisma.delivery.createMany({
    data: [
      { canonicalEventId: ce.id, platform: "META" },
      { canonicalEventId: ce.id, platform: "HUBSPOT" },
      { canonicalEventId: ce.id, platform: "GOOGLE_ADS" },
      { canonicalEventId: ce.id, platform: "TIKTOK" }
    ],
    skipDuplicates: true
  });

  await enqueueDelivery(ce.id);

  return NextResponse.json({ ok: true, canonicalEventId: ce.id, eventName, vaAttrib, eventId });
}
