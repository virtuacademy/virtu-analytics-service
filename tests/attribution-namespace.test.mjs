import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// Opus bookings own attribution tokens shaped `opus_<lessonId>`. Browser-supplied tokens
// (the va_attrib cookie and the Acuity intake field) must never point at one.

const bookingSource = loadTsModule(new URL("../src/lib/bookingSource.ts", import.meta.url), {});
const nextServer = {
  NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ingestWith(vaAttribCookie) {
  const upserts = [];
  const { POST } = loadTsModule(
    new URL("../src/app/api/attrib/ingest/route.ts", import.meta.url),
    {
      "next/server": nextServer,
      "@/lib/crypto": { randomId: () => crypto.randomUUID() },
      "@/lib/cors": { withCors: (res) => res },
      "@/lib/cookies": { setCookie: () => {}, setReadableCookie: () => {}, COOKIE_DOMAIN: "" },
      "@/lib/prisma": {
        prisma: {
          session: { findUnique: async () => null, upsert: async () => {} },
          visitor: { upsert: async () => {} },
          attribution: {
            findUnique: async () => null,
            upsert: async (args) => upserts.push(args),
          },
        },
      },
    },
    { process: { env: {} } },
  );
  const cookies = { va_attrib: vaAttribCookie };
  const response = await POST({
    headers: new Headers({ "user-agent": "Synthetic-Agent" }),
    json: async () => ({ url: "https://virtu.academy/trial" }),
    cookies: { get: (name) => (cookies[name] ? { value: cookies[name] } : undefined) },
  });
  return { token: upserts[0].where.token, response };
}

test("ingest replaces a va_attrib cookie that is not one of its UUID tokens", async () => {
  for (const cookie of ["opus_lesson-1", "anything-else"]) {
    const { token, response } = await ingestWith(cookie);
    assert.match(token, UUID);
    assert.equal(response.body.attribTok, token);
  }
  const existing = "12345678-1234-4123-8123-123456789abc";
  assert.equal((await ingestWith(existing)).token, existing);
});

test("an Acuity intake va_attrib naming an Opus token is ignored", async () => {
  const appointments = [];
  const events = [];
  const { POST } = loadTsModule(
    new URL("../src/app/api/webhooks/acuity/route.ts", import.meta.url),
    {
      "next/server": nextServer,
      "@/lib/auth": { timingSafeEqual: () => true },
      "@/lib/crypto": { sha256Base64: () => "sig", sha256Hex: () => "hash" },
      "@/lib/acuity": {
        fetchAppointmentById: async () => ({ id: 123, appointmentTypeID: 456 }),
        extractIntakeValue: (_appt, fieldId) => (fieldId === 111 ? "opus_lesson-1" : null),
        appointmentSnapshot: () => ({ scheduledBy: null }),
      },
      "@/lib/qstash": { enqueueDelivery: async () => {} },
      "@/lib/bookingSource": bookingSource,
      "@/lib/prisma": {
        prisma: {
          inboundWebhook: { create: async () => {} },
          appointment: { upsert: async (args) => appointments.push(args) },
          canonicalEvent: {
            create: async (args) => {
              events.push(args.data);
              return { id: "ce1" };
            },
            findFirst: async () => null,
          },
          delivery: { createMany: async () => {} },
        },
      },
    },
    {
      process: {
        env: {
          ACUITY_API_KEY: "synthetic",
          ACUITY_FIELD_VA_ATTRIB_ID: "111",
          ACUITY_TRIAL_APPOINTMENT_TYPE_IDS: "456",
        },
      },
    },
  );
  await POST({
    headers: new Headers({ "x-acuity-signature": "sig" }),
    text: async () => "action=scheduled&id=123",
  });
  assert.equal(appointments[0].create.vaAttrib, null);
  assert.equal(events[0].attributionTok, null);
});
