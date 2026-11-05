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

const attribToken = loadTsModule(new URL("../src/lib/attribToken.ts", import.meta.url), {});

// Runs the real ingest route. `cookies` are attrib's own cookies (only virtu.academy gets
// them back); `body` carries the IDs another site stored from an earlier response.
async function ingest({ cookies = {}, body = {} } = {}) {
  const visitors = [];
  const sessions = [];
  const attributions = [];
  const recentSession = { lastSeenAt: new Date() };
  const { POST } = loadTsModule(
    new URL("../src/app/api/attrib/ingest/route.ts", import.meta.url),
    {
      "next/server": nextServer,
      "@/lib/crypto": { randomId: () => crypto.randomUUID() },
      "@/lib/cors": { withCors: (res) => res },
      "@/lib/cookies": { setCookie: () => {}, setReadableCookie: () => {}, COOKIE_DOMAIN: "" },
      "@/lib/attribToken": attribToken,
      "@/lib/prisma": {
        prisma: {
          session: {
            findUnique: async () => recentSession,
            upsert: async (args) => sessions.push(args.where.id),
          },
          visitor: { upsert: async (args) => visitors.push(args.where.id) },
          attribution: {
            findUnique: async () => null,
            upsert: async (args) => attributions.push(args.where.token),
          },
        },
      },
    },
    { process: { env: {} } },
  );
  const response = await POST({
    headers: new Headers({ "user-agent": "Synthetic-Agent" }),
    json: async () => ({ url: "https://www.fortelessons.com/trial", ...body }),
    cookies: { get: (name) => (cookies[name] ? { value: cookies[name] } : undefined) },
  });
  return { vid: visitors[0], sid: sessions[0], token: attributions[0], response };
}

const VID = "12345678-1234-4123-8123-123456789abc";
const SID = "22345678-1234-4123-8123-123456789abc";
const TOKEN = "32345678-1234-4123-8123-123456789abc";

test("ingest replaces a va_attrib cookie that is not one of its UUID tokens", async () => {
  for (const cookie of ["opus_lesson-1", "anything-else"]) {
    const { token, response } = await ingest({ cookies: { va_attrib: cookie } });
    assert.match(token, UUID);
    assert.notEqual(token, cookie);
    assert.equal(response.body.attribTok, token);
  }
  assert.equal((await ingest({ cookies: { va_attrib: TOKEN } })).token, TOKEN);
});

test("another site's stored IDs are used when attrib's cookies are missing", async () => {
  const result = await ingest({ body: { vid: VID, sid: SID, attribTok: TOKEN } });
  assert.equal(result.vid, VID);
  assert.equal(result.sid, SID);
  assert.equal(result.token, TOKEN);
  assert.equal(result.response.body.vid, VID);
  assert.equal(result.response.body.sid, SID);
  assert.equal(result.response.body.attribTok, TOKEN);
});

test("malformed or opus_ body IDs get fresh UUIDs", async () => {
  for (const bad of ["opus_lesson-1", "not-a-uuid", 42, { id: TOKEN }, `${TOKEN} `]) {
    const result = await ingest({ body: { vid: bad, sid: bad, attribTok: bad } });
    for (const id of [result.vid, result.sid, result.token]) {
      assert.match(id, UUID);
      assert.notEqual(id, bad);
    }
  }
});

test("attrib's own cookies still win over body IDs on virtu.academy", async () => {
  const cookieIds = {
    va_vid: "42345678-1234-4123-8123-123456789abc",
    va_sid: "52345678-1234-4123-8123-123456789abc",
    va_attrib: "62345678-1234-4123-8123-123456789abc",
  };
  const result = await ingest({
    cookies: cookieIds,
    body: { vid: VID, sid: SID, attribTok: TOKEN },
  });
  assert.equal(result.vid, cookieIds.va_vid);
  assert.equal(result.sid, cookieIds.va_sid);
  assert.equal(result.token, cookieIds.va_attrib);
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
