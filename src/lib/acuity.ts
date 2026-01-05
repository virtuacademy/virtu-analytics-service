import { normEmail, normPhoneE164Digits } from "./normalize";

export type AcuityAppointment = {
  id: number;
  appointmentTypeID?: number;
  calendarID?: number;
  datetime?: string;
  canceled?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  fields?: Array<{ id: number; name?: string; value?: string }>;
};

function basicAuthHeader(userId: string, apiKey: string) {
  const token = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return `Basic ${token}`;
}

export async function fetchAppointmentById(appointmentId: string): Promise<AcuityAppointment> {
  const userId = process.env.ACUITY_USER_ID;
  const apiKey = process.env.ACUITY_API_KEY;
  if (!userId || !apiKey) throw new Error("Missing ACUITY_USER_ID/ACUITY_API_KEY");

  const url = `https://acuityscheduling.com/api/v1/appointments/${encodeURIComponent(appointmentId)}?pastFormAnswers=true`;
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(userId, apiKey)
    },
    cache: "no-store"
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Acuity fetch failed ${res.status}: ${t}`);
  }
  return (await res.json()) as AcuityAppointment;
}

export function extractIntakeValue(appt: AcuityAppointment, fieldId: number): string | null {
  const f = appt.fields?.find(x => x.id === fieldId);
  const v = f?.value?.trim();
  return v ? v : null;
}

export function appointmentSnapshot(appt: AcuityAppointment) {
  return {
    appointmentTypeId: appt.appointmentTypeID ? String(appt.appointmentTypeID) : null,
    calendarId: appt.calendarID ? String(appt.calendarID) : null,
    datetime: appt.datetime ?? null,
    status: appt.canceled ? "canceled" : "scheduled",
    email: normEmail(appt.email) ?? null,
    phone: normPhoneE164Digits(appt.phone) ?? null,
    firstName: appt.firstName?.trim() ?? null,
    lastName: appt.lastName?.trim() ?? null
  };
}
