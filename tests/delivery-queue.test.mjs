import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real queue helper (src/lib/qstash.ts) against a stubbed QStash client and database, and
// the hold an Acuity booking's Google Ads delivery starts with.

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

function queue(pending, options = {}) {
  const published = [];
  const released = [];
  const { queueDeliveries } = loadTsModule(
    new URL("../src/lib/qstash.ts", import.meta.url),
    {
      "@upstash/qstash": {
        Client: class {
          async publishJSON(request) {
            if (options.laterMessagesFail && request.notBefore) throw new Error("queue refused");
            published.push(request);
          }
        },
      },
      "@/lib/prisma": {
        prisma: {
          delivery: {
            findMany: async () => pending,
            updateMany: async (args) => released.push(args),
          },
        },
      },
    },
    {
      process: { env: { QSTASH_TOKEN: "synthetic", PUBLIC_BASE_URL: "https://attrib.example" } },
    },
  );
  return { queueDeliveries, published, released };
}

test("due deliveries are queued now and a held one for its own time", async () => {
  const heldUntil = inMinutes(370);
  const q = queue([
    { id: "hubspot", notBefore: null },
    { id: "google", notBefore: heldUntil },
  ]);
  await q.queueDeliveries("ce_1");

  assert.equal(q.published.length, 2);
  const later = q.published.find((message) => message.notBefore);
  const now = q.published.find((message) => !message.notBefore);
  assert.equal(later.notBefore, Math.ceil(heldUntil.getTime() / 1000));
  assert.equal(later.url, "https://attrib.example/api/qstash/deliver");
  assert.deepEqual({ ...later.body }, { canonicalEventId: "ce_1" });
  assert.deepEqual({ ...now.body }, { canonicalEventId: "ce_1" });
  assert.equal(q.released.length, 0);

  // Nothing due yet: no message that would only find a held delivery.
  const onlyHeld = queue([{ id: "google", notBefore: heldUntil }]);
  await onlyHeld.queueDeliveries("ce_1");
  assert.deepEqual(
    onlyHeld.published.map((message) => Boolean(message.notBefore)),
    [true],
  );
});

test("a held delivery that cannot be scheduled is released and sent now", async () => {
  const q = queue([{ id: "google", notBefore: inMinutes(370) }], { laterMessagesFail: true });
  await q.queueDeliveries("ce_1");

  // The hold is lifted in the database, then the worker is asked to deliver at once.
  assert.deepEqual(JSON.parse(JSON.stringify(q.released)), [
    { where: { id: { in: ["google"] } }, data: { notBefore: null } },
  ]);
  assert.equal(q.published.length, 1);
  assert.equal(q.published[0].notBefore, undefined);
});

// Runs the real Acuity webhook for a self-scheduled trial. `visit` is the ingest row its
// va_attrib intake value names, if any.
async function acuityBooking(visit) {
  const VISIT = "0b6c5a1e-3f4d-4c2b-9a8e-7d6f5e4c3b2a";
  const env = {
    ACUITY_API_KEY: "synthetic",
    ACUITY_FIELD_VA_ATTRIB_ID: "111",
    ACUITY_TRIAL_APPOINTMENT_TYPE_IDS: "456",
  };
  const deliveries = [];
  const queued = [];
  const lib = (file) =>
    loadTsModule(new URL(`../src/lib/${file}`, import.meta.url), {}, { process: { env } });
  const { POST } = loadTsModule(
    new URL("../src/app/api/webhooks/acuity/route.ts", import.meta.url),
    {
      "next/server": {
        NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
      },
      "@/lib/auth": { timingSafeEqual: () => true },
      "@/lib/crypto": { sha256Base64: () => "sig", sha256Hex: () => "hash" },
      "@/lib/acuity": {
        fetchAppointmentById: async () => ({ id: 123, appointmentTypeID: 456 }),
        extractIntakeValue: (_appt, fieldId) => (visit && fieldId === 111 ? VISIT : null),
        appointmentSnapshot: () => ({ scheduledBy: null }),
      },
      "@/lib/qstash": { queueDeliveries: async (id) => queued.push(id) },
      "@/lib/bookingSource": lib("bookingSource.ts"),
      "@/lib/googleAdsHold": lib("googleAdsHold.ts"),
      "@/lib/prisma": {
        prisma: {
          inboundWebhook: { create: async () => {} },
          appointment: { upsert: async () => {} },
          attribution: { findUnique: async ({ where }) => (where.token === VISIT ? visit : null) },
          canonicalEvent: { create: async () => ({ id: "ce_1" }), findFirst: async () => null },
          delivery: { createMany: async ({ data }) => deliveries.push(...data) },
        },
      },
    },
    { process: { env } },
  );
  await POST({
    headers: new Headers({ "x-acuity-signature": "sig" }),
    text: async () => "action=scheduled&id=123",
  });
  return { deliveries, queued };
}

test("an Acuity booking made minutes after the ad click holds only its Google Ads delivery", async () => {
  const HOLD_MS = 375 * 60 * 1000;
  const notBeforeOf = (booking, platform) =>
    booking.deliveries.find((delivery) => delivery.platform === platform).notBefore;

  const lastTouchAt = inMinutes(-6);
  const fresh = await acuityBooking({ lastTouchAt });
  assert.equal(notBeforeOf(fresh, "GOOGLE_ADS").getTime(), lastTouchAt.getTime() + HOLD_MS);
  for (const platform of ["META", "HUBSPOT", "TIKTOK", "OPENAI"]) {
    assert.equal(notBeforeOf(fresh, platform), undefined, platform);
  }
  assert.deepEqual(fresh.queued, ["ce_1"]);

  // A visit last seen more than six and a quarter hours ago is not kept waiting.
  const returning = await acuityBooking({ lastTouchAt: inMinutes(-400) });
  assert.equal(notBeforeOf(returning, "GOOGLE_ADS"), null);

  // No linked visit: the click is no later than the booking itself.
  const before = Date.now();
  const unlinked = await acuityBooking(null);
  assert.ok(notBeforeOf(unlinked, "GOOGLE_ADS").getTime() >= before + HOLD_MS);
});
