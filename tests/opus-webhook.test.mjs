import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real /api/webhooks/opus route against an in-memory transaction and queue.
// Contract: docs/opus-trial-webhook.md.

const require = createRequire(import.meta.url);
const zod = require("zod");
const SECRET = "synthetic-opus-secret";

const libs = {
  "@/lib/crypto": loadTsModule(new URL("../src/lib/crypto.ts", import.meta.url), {
    crypto: nodeCrypto,
  }),
  "@/lib/auth": loadTsModule(
    new URL("../src/lib/auth.ts", import.meta.url),
    {},
    { crypto: webcrypto, Buffer, btoa, atob },
  ),
  "@/lib/bookingSource": loadTsModule(new URL("../src/lib/bookingSource.ts", import.meta.url), {}),
  "@/lib/attribToken": loadTsModule(new URL("../src/lib/attribToken.ts", import.meta.url), {}),
};

function payload(overrides = {}) {
  const base = {
    schemaVersion: 1,
    type: "trial.booked",
    eventId: "opus_lesson-1",
    occurredAt: "2026-11-04T18:22:05.000Z",
    booking: {
      lessonId: "lesson-1",
      startsAt: "2026-11-10T23:00:00.000Z",
      durationMinutes: 30,
      instrument: "Piano",
      valueCents: 3500,
      currency: "USD",
      invoicePaid: true,
    },
    contact: {
      email: "parent@example.com",
      phone: "+15555550123",
      firstName: "Pat",
      lastName: "Example",
    },
    client: { ip: "203.0.113.7", userAgent: "Synthetic-Agent" },
    attribution: {
      landingUrl: "https://app.fortelessons.com/teacher/profile/abc?gclid=G-1",
      referrer: "https://www.fortelessons.com/trial",
      firstTouchAt: "2026-11-04T18:01:44.000Z",
      lastTouchAt: "2026-11-04T18:05:00.000Z",
      utm: { source: "google", medium: "cpc", campaign: "trial", term: null, content: null },
      click: {
        gclid: "G-1",
        gbraid: null,
        wbraid: null,
        fbclid: null,
        ttclid: null,
        msclkid: null,
      },
    },
    flags: { staffInitiated: false },
  };
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...merged[key], ...value }
        : value;
  }
  return merged;
}

function sign(raw, timestamp = Math.floor(Date.now() / 1000), secret = SECRET) {
  return {
    "x-opus-timestamp": String(timestamp),
    "x-opus-signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`,
  };
}

function webhook(options = {}) {
  const committed = [];
  const ingestLookups = [];
  const eventLookups = [];
  const queued = [];
  const env = {
    OPUS_WEBHOOK_SECRET: SECRET,
    OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT",
    ...options.env,
  };
  const write = (writes, table, result) => async (args) => {
    if (options.failOn === table) throw options.error;
    writes.push({ table, data: args.data });
    return result;
  };
  const prisma = {
    // Writes become visible only when the callback resolves, like a rolled-back transaction.
    $transaction: async (callback) => {
      const writes = [];
      const result = await callback({
        inboundWebhook: { create: write(writes, "inboundWebhook") },
        appointment: { create: write(writes, "appointment") },
        attribution: { create: write(writes, "attribution") },
        canonicalEvent: { create: write(writes, "canonicalEvent", { id: "ce_1" }) },
        eventContact: { create: write(writes, "eventContact") },
        delivery: { createMany: write(writes, "delivery") },
      });
      committed.push(...writes);
      return result;
    },
    canonicalEvent: {
      findFirst: async ({ where }) => {
        eventLookups.push(where);
        return options.existing ?? null;
      },
    },
    // The visitor's ingest rows, read before the transaction.
    attribution: {
      findUnique: async ({ where }) => {
        ingestLookups.push(where.token);
        return options.ingestRows?.[where.token] ?? null;
      },
    },
  };
  const { POST } = loadTsModule(
    new URL("../src/app/api/webhooks/opus/route.ts", import.meta.url),
    {
      "next/server": {
        NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
      },
      zod,
      "@/lib/prisma": { prisma },
      // A new event is queued with queueDeliveries, a resend's leftovers with enqueueDelivery.
      "@/lib/qstash": {
        enqueueDelivery: async (id) => queued.push(id),
        queueDeliveries: async (id) => queued.push(id),
      },
      "@/lib/adEvents": loadTsModule(
        new URL("../src/lib/adEvents.ts", import.meta.url),
        {},
        { process: { env } },
      ),
      "@/lib/googleAdsHold": loadTsModule(
        new URL("../src/lib/googleAdsHold.ts", import.meta.url),
        {},
        { process: { env } },
      ),
      ...libs,
    },
    { process: { env } },
  );
  const send = (body, headers) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return POST({ text: async () => raw, headers: new Headers(headers ?? sign(raw)) });
  };
  const rows = (table) => committed.filter((w) => w.table === table).map((w) => w.data);
  return { send, committed, queued, rows, ingestLookups, eventLookups };
}

// An account created in Opus: no booking, an `account` with the user's ID.
function accountPayload(overrides = {}) {
  const body = payload({
    type: "account.created",
    eventId: "opus_account_user-1",
    account: { userId: "user-1" },
    ...overrides,
  });
  delete body.booking;
  return body;
}

test("a signed trial booking is recorded once and queued for Google Ads and HubSpot", async () => {
  const w = webhook();
  const response = await w.send(payload());

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.eventId, "opus_lesson-1");
  assert.equal(response.body.canonicalEventId, "ce_1");

  const [inbound] = w.rows("inboundWebhook");
  assert.equal(inbound.source, "opus");
  assert.equal(inbound.action, "trial.booked");
  assert.equal(inbound.externalId, "opus_lesson-1");

  const [appointment] = w.rows("appointment");
  assert.equal(appointment.id, "opus_lesson-1");
  assert.equal(appointment.vaAttrib, "opus_lesson-1");
  assert.equal(appointment.email, "parent@example.com");
  assert.equal(appointment.datetime, "2026-11-10T23:00:00.000Z");
  assert.equal(appointment.gclid, "G-1");
  assert.equal(appointment.scheduledBy, null);

  const [attribution] = w.rows("attribution");
  assert.equal(attribution.token, "opus_lesson-1");
  assert.equal(attribution.ipAddress, "203.0.113.7");
  assert.equal(attribution.userAgent, "Synthetic-Agent");
  assert.equal(attribution.gclid, "G-1");
  assert.equal(attribution.utmSource, "google");
  assert.equal(attribution.lastUrl, payload().attribution.landingUrl);
  assert.equal(attribution.firstTouchAt.toISOString(), "2026-11-04T18:01:44.000Z");

  const [event] = w.rows("canonicalEvent");
  assert.equal(event.name, "TRIAL_BOOKED");
  assert.equal(event.eventId, "opus_lesson-1");
  assert.equal(event.attributionTok, "opus_lesson-1");
  assert.equal(event.value, 35);
  assert.equal(event.eventTime.toISOString(), "2026-11-04T18:22:05.000Z");

  const [deliveries] = w.rows("delivery");
  assert.deepEqual(
    Array.from(deliveries, (d) => [d.platform, d.status, d.canonicalEventId]),
    [
      ["GOOGLE_ADS", "PENDING", "ce_1"],
      ["HUBSPOT", "PENDING", "ce_1"],
      ["META", "SKIPPED", "ce_1"],
    ],
  );
  assert.deepEqual(w.queued, ["ce_1"]);
});

test("unsigned, forged, tampered and stale requests are rejected before anything is written", async () => {
  const raw = JSON.stringify(payload());
  const now = Math.floor(Date.now() / 1000);
  for (const headers of [
    {},
    sign(raw, now, "wrong-secret"),
    sign(JSON.stringify(payload({ booking: { valueCents: 1 } }))),
    sign(raw, now - 400),
    sign(raw, now + 400),
    { ...sign(raw), "x-opus-timestamp": "not-a-number" },
  ]) {
    const w = webhook();
    const response = await w.send(raw, headers);
    assert.equal(response.status, 401);
    assert.equal(w.committed.length, 0);
    assert.equal(w.queued.length, 0);
  }
});

test("a missing shared secret fails closed", async () => {
  const w = webhook({ env: { OPUS_WEBHOOK_SECRET: "" } });
  assert.equal((await w.send(payload())).status, 500);
  assert.equal(w.committed.length, 0);
});

test("bodies outside the contract are rejected without writes", async () => {
  for (const body of [
    "not json",
    payload({ schemaVersion: 2 }),
    payload({ type: "trial.canceled" }),
    payload({ eventId: "opus_someone-else" }),
    payload({ eventId: "opus_bad id", booking: { lessonId: "bad id" } }),
    payload({ booking: { currency: "usd" } }),
    payload({ occurredAt: "yesterday" }),
    payload({ attribution: { landingUrl: `https://app.fortelessons.com/${"x".repeat(2048)}` } }),
    { ...payload(), booking: undefined },
    accountPayload({ eventId: "opus_user-1" }),
    accountPayload({ eventId: "opus_account_bad id", account: { userId: "bad id" } }),
    { ...accountPayload(), account: undefined },
  ]) {
    const w = webhook();
    const response = await w.send(body);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(w.committed.length, 0);
  }
});

test("optional values may be null or omitted", async () => {
  const body = payload({ contact: { phone: undefined }, client: { ip: null } });
  delete body.attribution.click.msclkid;
  const w = webhook();
  assert.equal((await w.send(body)).status, 200);
  assert.equal(w.rows("appointment")[0].phone, null);
  assert.equal(w.rows("attribution")[0].ipAddress, null);
  assert.equal(w.rows("attribution")[0].msclkid, null);
});

test("a resend is deduplicated and requeues only deliveries left unattempted for 10 minutes", async () => {
  const duplicate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
  for (const [createdAt, deliveries, requeued] of [
    // Fresh: the first request's queue message may still be on its way to the worker.
    [minutesAgo(1), [{ status: "PENDING", attempts: 0 }], false],
    [minutesAgo(11), [{ status: "PENDING", attempts: 0 }], true],
    [minutesAgo(11), [{ status: "SUCCESS", attempts: 1 }], false],
    [minutesAgo(11), [{ status: "FAILED", attempts: 1 }], false],
    // Held for Google: its later message is still to come, until that time is well past.
    [minutesAgo(11), [{ status: "PENDING", attempts: 0, notBefore: minutesAgo(-300) }], false],
    [minutesAgo(400), [{ status: "PENDING", attempts: 0, notBefore: minutesAgo(11) }], true],
  ]) {
    const w = webhook({
      failOn: "appointment",
      error: duplicate,
      existing: { id: "ce_existing", createdAt, deliveries },
    });
    const response = await w.send(payload());
    assert.equal(response.status, 200);
    assert.equal(response.body.deduped, true);
    assert.equal(response.body.requeued, requeued);
    assert.equal(w.committed.length, 0);
    assert.deepEqual(w.queued, requeued ? ["ce_existing"] : []);
  }
});

test("a unique conflict without this booking's event is a 409, not a dedupe", async () => {
  const w = webhook({
    failOn: "attribution",
    error: Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    existing: null,
  });
  const response = await w.send(payload());
  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "Conflicting record for this eventId");
  assert.equal(w.committed.length, 0);
  assert.equal(w.queued.length, 0);
});

test("staff bookings are recorded but never delivered", async () => {
  const w = webhook();
  const response = await w.send(payload({ flags: { staffInitiated: true } }));
  assert.equal(response.status, 200);
  assert.equal(response.body.skippedOutbound, true);
  assert.equal(w.rows("appointment")[0].scheduledBy, "opus:staff");
  assert.equal(w.rows("delivery").length, 0);
  assert.equal(w.queued.length, 0);
});

test("Opus deliveries stay off until each platform is enabled", async () => {
  for (const [enabled, expected, queued] of [
    ["", ["SKIPPED", "SKIPPED", "SKIPPED"], []],
    [" hubspot ", ["SKIPPED", "PENDING", "SKIPPED"], ["ce_1"]],
  ]) {
    const w = webhook({ env: { OPUS_DELIVERY_PLATFORMS: enabled } });
    assert.equal((await w.send(payload())).status, 200);
    const [deliveries] = w.rows("delivery");
    assert.deepEqual(
      Array.from(deliveries, (d) => d.status),
      expected,
    );
    const skipped = deliveries.find((d) => d.status === "SKIPPED");
    assert.match(skipped.responseBody, /OPUS_DELIVERY_PLATFORMS/);
    assert.deepEqual(w.queued, queued);
  }
});

test("other database failures answer 500 without leaking details", async () => {
  const w = webhook({
    failOn: "canonicalEvent",
    error: Object.assign(new Error("private connection detail"), { code: "P1001" }),
  });
  const response = await w.send(payload());
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes("private"), false);
  assert.equal(w.committed.length, 0);
});

const INGEST_TOKEN = "0b6c5a1e-3f4d-4c2b-9a8e-7d6f5e4c3b2a";
const ingestRow = {
  token: INGEST_TOKEN,
  firstTouchAt: new Date("2026-11-01T09:00:00.000Z"),
  lastTouchAt: new Date("2026-11-04T18:00:00.000Z"),
  firstUrl: "https://www.fortelessons.com/trial?gclid=G-ingest",
  lastUrl: "https://www.fortelessons.com/teachers",
  firstReferrer: "https://www.google.com/",
  lastReferrer: "https://www.fortelessons.com/trial",
  ipAddress: "198.51.100.1",
  userAgent: "Landing-Agent",
  utmSource: "google",
  utmMedium: "cpc",
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  gclid: "G-ingest",
  gbraid: null,
  wbraid: null,
  dclid: null,
  fbclid: null,
  fbp: "fb.1.1730000000000.123",
  fbc: null,
  ttclid: null,
  ttp: "ttp-1",
  msclkid: null,
  hubspotutk: "utk-1",
  visitorId: "vid-1",
  sessionId: "sid-1",
};

test("a known vaAttrib freezes the ingest row, with the event filling only its gaps", async () => {
  const w = webhook({ ingestRows: { [INGEST_TOKEN]: ingestRow } });
  const body = payload({
    attribution: {
      vaAttrib: INGEST_TOKEN,
      utm: {
        source: "newsletter",
        medium: "email",
        campaign: "app-campaign",
        term: null,
        content: null,
      },
      click: {
        gclid: "G-app",
        gbraid: null,
        wbraid: "W-app",
        fbclid: null,
        ttclid: null,
        msclkid: null,
      },
    },
  });
  assert.equal((await w.send(body)).status, 200);
  assert.deepEqual(w.ingestLookups, [INGEST_TOKEN]);

  const [snapshot] = w.rows("attribution");
  assert.equal(snapshot.token, "opus_lesson-1");
  // The ingest row wins where it has a value...
  assert.equal(snapshot.utmSource, "google");
  assert.equal(snapshot.utmMedium, "cpc");
  assert.equal(snapshot.gclid, "G-ingest");
  assert.equal(snapshot.firstUrl, ingestRow.firstUrl);
  assert.equal(snapshot.lastReferrer, ingestRow.lastReferrer);
  assert.equal(snapshot.firstTouchAt, ingestRow.firstTouchAt);
  assert.equal(snapshot.fbp, ingestRow.fbp);
  assert.equal(snapshot.ttp, "ttp-1");
  assert.equal(snapshot.hubspotutk, "utk-1");
  assert.equal(snapshot.visitorId, "vid-1");
  assert.equal(snapshot.sessionId, "sid-1");
  // ...the event fills what it lacks...
  assert.equal(snapshot.utmCampaign, "app-campaign");
  assert.equal(snapshot.wbraid, "W-app");
  // ...and IP and user agent come from the booking request.
  assert.equal(snapshot.ipAddress, "203.0.113.7");
  assert.equal(snapshot.userAgent, "Synthetic-Agent");

  const [appointment] = w.rows("appointment");
  assert.equal(appointment.vaAttrib, INGEST_TOKEN);
  assert.equal(appointment.gclid, "G-ingest");
  assert.equal(w.rows("canonicalEvent")[0].attributionTok, "opus_lesson-1");
});

test("Meta, TikTok and HubSpot browser IDs from Opus fill what the ingest row lacks", async () => {
  const fromOpus = {
    fbp: "fb.1.1730000000000.999",
    fbc: "fb.1.1730000000000.IwAR-opus",
    ttp: "ttp-opus",
  };
  const withBrowserIds = (vaAttrib) =>
    payload({
      attribution: {
        vaAttrib,
        hubspotutk: "utk-opus",
        click: { ...payload().attribution.click, ...fromOpus },
      },
    });

  // Without a marketing-site visit, the booking's own cookies are stored.
  const alone = webhook();
  assert.equal((await alone.send(withBrowserIds(undefined))).status, 200);
  const [own] = alone.rows("attribution");
  assert.equal(own.fbp, fromOpus.fbp);
  assert.equal(own.fbc, fromOpus.fbc);
  assert.equal(own.ttp, fromOpus.ttp);
  assert.equal(own.hubspotutk, "utk-opus");

  // With one, the visit's values win and Opus fills only the gaps (the visit has no _fbc).
  const linked = webhook({ ingestRows: { [INGEST_TOKEN]: ingestRow } });
  assert.equal((await linked.send(withBrowserIds(INGEST_TOKEN))).status, 200);
  const [snapshot] = linked.rows("attribution");
  assert.equal(snapshot.fbp, ingestRow.fbp);
  assert.equal(snapshot.ttp, ingestRow.ttp);
  assert.equal(snapshot.hubspotutk, ingestRow.hubspotutk);
  assert.equal(snapshot.fbc, fromOpus.fbc);
});

test("a missing, malformed or unknown vaAttrib behaves exactly as without one", async () => {
  const baseline = webhook();
  await baseline.send(payload());
  const unknown = "11111111-2222-4333-8444-555555555555";
  for (const [vaAttrib, lookups] of [
    [undefined, []],
    [null, []],
    ["opus_lesson-2", []],
    ["not-a-uuid", []],
    [42, []],
    [unknown, [unknown]],
  ]) {
    const w = webhook({ ingestRows: { [INGEST_TOKEN]: ingestRow } });
    const response = await w.send(payload({ attribution: { vaAttrib } }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(w.ingestLookups, lookups);
    // Rows come from separate module sandboxes, so compare them as plain JSON.
    assert.equal(
      JSON.stringify(w.rows("attribution")),
      JSON.stringify(baseline.rows("attribution")),
    );
    assert.equal(w.rows("appointment")[0].vaAttrib, "opus_lesson-1");
  }
});

test("an ingest row touched more than 10 minutes after the booking is treated as unknown", async () => {
  // occurredAt is 2026-11-04T18:22:05Z; the cutoff is 18:32:05Z.
  const baseline = webhook();
  await baseline.send(payload());
  for (const [lastTouchAt, linked] of [
    ["2026-11-04T18:32:05.000Z", true],
    ["2026-11-04T18:32:05.001Z", false],
    ["2026-11-20T09:00:00.000Z", false],
  ]) {
    const row = { ...ingestRow, lastTouchAt: new Date(lastTouchAt), gclid: "G-later-visit" };
    const w = webhook({ ingestRows: { [INGEST_TOKEN]: row } });
    assert.equal((await w.send(payload({ attribution: { vaAttrib: INGEST_TOKEN } }))).status, 200);
    const [snapshot] = w.rows("attribution");
    const [appointment] = w.rows("appointment");
    if (linked) {
      assert.equal(snapshot.gclid, "G-later-visit");
      assert.equal(appointment.vaAttrib, INGEST_TOKEN);
    } else {
      assert.equal(
        JSON.stringify(w.rows("attribution")),
        JSON.stringify(baseline.rows("attribution")),
      );
      assert.equal(appointment.vaAttrib, "opus_lesson-1");
    }
  }
});

test("Meta gets an Opus booking whether or not it is linked to a visit", async () => {
  const env = { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT,META" };
  const trialPage = "https://lessons.virtu.academy/trial?fbclid=IwAR-1";
  for (const [name, row] of [
    ["a visit to the paid-ads trial page", { ...ingestRow, firstUrl: trialPage }],
    ["a Forte marketing-site visit", ingestRow],
    // Booked in another browser than the one that clicked the ad: the booker's hashed email
    // and phone are all Meta has to match on.
    ["no linked visit", null],
  ]) {
    const w = webhook({ env, ingestRows: row ? { [INGEST_TOKEN]: row } : {} });
    assert.equal((await w.send(payload({ attribution: { vaAttrib: INGEST_TOKEN } }))).status, 200);
    const [deliveries] = w.rows("delivery");
    assert.deepEqual(
      Object.fromEntries(Array.from(deliveries, (d) => [d.platform, d.status])),
      { GOOGLE_ADS: "PENDING", HUBSPOT: "PENDING", META: "PENDING" },
      name,
    );
  }
});

test("a new account is its own event with no appointment, sent to Google Ads and Meta only", async () => {
  for (const [type, name] of [
    ["account.created", "ACCOUNT_CREATED"],
    ["teacher_account.created", "TEACHER_ACCOUNT_CREATED"],
  ]) {
    const w = webhook({ env: { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT,META" } });
    const response = await w.send(accountPayload({ type }));
    assert.equal(response.status, 200, type);
    assert.equal(response.body.eventId, "opus_account_user-1");

    assert.equal(w.rows("inboundWebhook")[0].action, type);
    // Nothing the dashboard or HubSpot delivery would read as a booking.
    assert.equal(w.rows("appointment").length, 0);
    assert.equal(w.rows("attribution")[0].token, "opus_account_user-1");
    assert.equal(w.rows("attribution")[0].gclid, "G-1");

    const [event] = w.rows("canonicalEvent");
    assert.equal(event.name, name);
    assert.equal(event.appointmentId, null);
    assert.equal(event.attributionTok, "opus_account_user-1");
    assert.equal(event.eventTime.toISOString(), "2026-11-04T18:22:05.000Z");

    assert.deepEqual(
      { ...w.rows("eventContact")[0] },
      {
        canonicalEventId: "ce_1",
        email: "parent@example.com",
        phone: "+15555550123",
        firstName: "Pat",
        lastName: "Example",
        vaAttrib: null,
        staffInitiated: false,
      },
    );

    // No HubSpot row: Opus writes these contacts to HubSpot itself.
    assert.deepEqual(
      Array.from(w.rows("delivery")[0], (d) => [d.platform, d.status]),
      [
        ["GOOGLE_ADS", "PENDING"],
        ["META", "PENDING"],
      ],
    );
    assert.deepEqual(w.queued, ["ce_1"]);
  }
});

test("a resent account writes nothing, and the same user as family and teacher is a conflict", async () => {
  const duplicate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const resent = webhook({
    failOn: "attribution",
    error: duplicate,
    existing: { id: "ce_existing", createdAt: new Date(), deliveries: [] },
  });
  const response = await resent.send(accountPayload());
  assert.equal(response.status, 200);
  assert.equal(response.body.deduped, true);
  assert.equal(resent.committed.length, 0);
  assert.equal(resent.queued.length, 0);
  // Found by its own name, so a teacher event never passes for the family one.
  assert.deepEqual(
    { ...resent.eventLookups[0] },
    {
      eventId: "opus_account_user-1",
      name: "ACCOUNT_CREATED",
    },
  );

  const other = webhook({ failOn: "attribution", error: duplicate, existing: null });
  const conflict = await other.send(accountPayload({ type: "teacher_account.created" }));
  assert.equal(conflict.status, 409);
  assert.equal(other.eventLookups[0].name, "TEACHER_ACCOUNT_CREATED");
  assert.equal(other.committed.length, 0);
});

test("an account stays off Meta until it is listed, and staff accounts are never delivered", async () => {
  // The default test setting lists Google Ads and HubSpot only.
  const off = webhook();
  await off.send(accountPayload());
  const meta = off.rows("delivery")[0].find((d) => d.platform === "META");
  assert.equal(meta.status, "SKIPPED");
  assert.match(meta.responseBody, /OPUS_DELIVERY_PLATFORMS/);

  const staff = webhook({ env: { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" } });
  const response = await staff.send(accountPayload({ flags: { staffInitiated: true } }));
  assert.equal(response.body.skippedOutbound, true);
  assert.equal(staff.rows("eventContact")[0].staffInitiated, true);
  assert.equal(staff.rows("delivery").length, 0);
  assert.equal(staff.queued.length, 0);
});

test("an account's value comes from EVENT_VALUES, and none is stored without an entry", async () => {
  const env = { EVENT_VALUES: "opus:ACCOUNT_CREATED=15, opus:TEACHER_ACCOUNT_CREATED=20.5" };
  for (const [type, value, currency] of [
    ["account.created", 15, "USD"],
    ["teacher_account.created", 20.5, "USD"],
  ]) {
    const w = webhook({ env });
    await w.send(accountPayload({ type }));
    assert.equal(w.rows("canonicalEvent")[0].value, value);
    assert.equal(w.rows("canonicalEvent")[0].currency, currency);
  }
  const unset = webhook({ env: { EVENT_VALUES: "page:CALLBACK_REQUESTED=15" } });
  await unset.send(accountPayload());
  assert.equal(unset.rows("canonicalEvent")[0].value, null);
  assert.equal(unset.rows("canonicalEvent")[0].currency, null);
  // A booking keeps the price Opus sent.
  const booking = webhook({ env });
  await booking.send(payload());
  assert.equal(booking.rows("canonicalEvent")[0].value, 35);
});

test("an account with no click ID and no email or phone is recorded but not delivered", async () => {
  const noClick = { gclid: null, gbraid: null, wbraid: null, fbclid: null, ttclid: null };
  const env = { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" };
  const nothing = webhook({ env });
  await nothing.send(
    accountPayload({ contact: { email: null, phone: null }, attribution: { click: noClick } }),
  );
  for (const delivery of nothing.rows("delivery")[0]) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, /No click ID and no contact details/);
  }
  assert.equal(nothing.queued.length, 0);

  // Either one is enough.
  for (const overrides of [
    { attribution: { click: noClick } },
    { contact: { email: null, phone: null } },
  ]) {
    const w = webhook({ env });
    await w.send(accountPayload(overrides));
    assert.deepEqual(
      Array.from(w.rows("delivery")[0], (d) => d.status),
      ["PENDING", "PENDING"],
    );
  }
});

test("a Google Ads delivery waits six and a quarter hours after the visit's last touch", async () => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
  const HOLD_MS = 375 * 60 * 1000;
  const notBeforeOf = (w, platform) =>
    w.rows("delivery")[0].find((d) => d.platform === platform).notBefore;
  const sendNow = (w, lastTouchAt, more = {}) =>
    w.send(
      payload({
        occurredAt: new Date().toISOString(),
        attribution: { lastTouchAt: lastTouchAt.toISOString(), ...more },
      }),
    );

  // A booking minutes after the ad click: held, not uploaded and rejected as too recent.
  const lastTouch = minutesAgo(10);
  const fresh = webhook();
  await sendNow(fresh, lastTouch);
  assert.equal(notBeforeOf(fresh, "GOOGLE_ADS").getTime(), lastTouch.getTime() + HOLD_MS);
  // Only Google has the rule.
  assert.equal(notBeforeOf(fresh, "HUBSPOT"), null);

  // The click ID can come from the ingest row or from Opus's own capture, so the later touch counts.
  const ingestTouch = minutesAgo(3);
  const linked = webhook({
    ingestRows: { [INGEST_TOKEN]: { ...ingestRow, lastTouchAt: ingestTouch } },
  });
  await sendNow(linked, minutesAgo(90), { vaAttrib: INGEST_TOKEN });
  assert.equal(notBeforeOf(linked, "GOOGLE_ADS").getTime(), ingestTouch.getTime() + HOLD_MS);

  // An old click goes at once, and so does everything with the hold switched off.
  const old = webhook();
  await sendNow(old, minutesAgo(400));
  assert.equal(notBeforeOf(old, "GOOGLE_ADS"), null);
  const off = webhook({ env: { GOOGLE_ADS_HOLD_MINUTES: "0" } });
  await sendNow(off, lastTouch);
  assert.equal(notBeforeOf(off, "GOOGLE_ADS"), null);

  // An account is held the same way.
  const account = webhook();
  await account.send(
    accountPayload({
      occurredAt: new Date().toISOString(),
      attribution: { lastTouchAt: lastTouch.toISOString() },
    }),
  );
  assert.equal(notBeforeOf(account, "GOOGLE_ADS").getTime(), lastTouch.getTime() + HOLD_MS);
});
