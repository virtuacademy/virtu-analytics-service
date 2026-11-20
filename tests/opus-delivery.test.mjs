import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// Opus bookings through the real Google Ads and Meta adapters and QStash worker, with every
// network and database boundary stubbed. Contract: docs/opus-trial-webhook.md.

const cryptoLib = loadTsModule(new URL("../src/lib/crypto.ts", import.meta.url), {
  crypto: nodeCrypto,
});
const bookingSource = loadTsModule(new URL("../src/lib/bookingSource.ts", import.meta.url), {});
const normalize = loadTsModule(new URL("../src/lib/normalize.ts", import.meta.url), {});

const googleEnv = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "synthetic-dev-token",
  GOOGLE_ADS_CLIENT_ID: "synthetic-client",
  GOOGLE_ADS_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "synthetic-refresh",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
  GOOGLE_ADS_CONVERSION_ACTION_ID: "999",
  GOOGLE_ADS_CONVERSION_ACTIONS: "TRIAL_BOOKED=111,opus:TRIAL_BOOKED=222",
};

// `uploadResponse` is what Google answers an upload with (an empty success by default).
function googleAds(envOverrides = {}, uploadResponse = {}) {
  const uploads = [];
  const fetchCalls = [];
  const fetch = async (url, init) => {
    fetchCalls.push(String(url));
    if (String(url).startsWith("https://oauth2.googleapis.com/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "token", expires_in: 3600 }),
      };
    }
    uploads.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(uploadResponse) };
  };
  const { sendGoogleAdsClickConversion } = loadTsModule(
    new URL("../src/lib/outbound/googleAds.ts", import.meta.url),
    { "../crypto": cryptoLib },
    { process: { env: { ...googleEnv, ...envOverrides } }, fetch },
  );
  const send = (args = {}) =>
    sendGoogleAdsClickConversion({
      eventId: "opus_lesson-1",
      eventName: "TRIAL_BOOKED",
      eventTime: new Date("2026-11-04T18:22:05.000Z"),
      gclid: "G-1",
      email: "parent@example.com",
      ...args,
    });
  return { send, uploads, fetchCalls };
}

const actionOf = (upload) => upload.conversions[0].conversionAction;

test("Opus conversions upload to the Opus conversion action", async () => {
  const g = googleAds();
  const result = await g.send({ source: "opus" });
  assert.equal(result.ok, true);
  assert.equal(result.validateOnly, false);
  assert.equal(actionOf(g.uploads[0]), "customers/1234567890/conversionActions/222");
  assert.equal(g.uploads[0].conversions[0].orderId, "opus_lesson-1");
  assert.equal(g.uploads[0].validateOnly, undefined);
});

test("Acuity conversions keep the Acuity action", async () => {
  for (const source of [undefined, null, "acuity"]) {
    const g = googleAds();
    await g.send({ eventId: "123", source });
    assert.equal(actionOf(g.uploads[0]), "customers/1234567890/conversionActions/111");
  }
});

test("Opus conversions never fall back to the Acuity or default action", async () => {
  const g = googleAds({ GOOGLE_ADS_CONVERSION_ACTIONS: "TRIAL_BOOKED=111" });
  const result = await g.send({ source: "opus" });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /opus:TRIAL_BOOKED/);
  assert.equal(g.fetchCalls.length, 0);
});

test("only the gclid is uploaded; a braid-only booking falls back to email and phone", async () => {
  const clickKeys = (upload) =>
    Object.keys(upload.conversions[0]).filter((key) => /gclid|braid|userIdentifiers/.test(key));

  // Google rejects braids on one-per-click actions, so they never go out, even next to a gclid.
  const both = googleAds();
  await both.send({ gbraid: "B-1", wbraid: "W-1" });
  assert.deepEqual(clickKeys(both.uploads[0]), ["gclid", "userIdentifiers"]);

  const braidOnly = googleAds();
  await braidOnly.send({ gclid: null, gbraid: "B-1" });
  assert.deepEqual(clickKeys(braidOnly.uploads[0]), ["userIdentifiers"]);

  const nothingToMatch = googleAds();
  const result = await nothingToMatch.send({ gclid: null, gbraid: "B-1", email: null });
  assert.equal(result.skipped, true);
  assert.equal(nothingToMatch.fetchCalls.length, 0);
});

test("validate-only uploads are flagged so they are never counted as delivered", async () => {
  const g = googleAds({ GOOGLE_ADS_VALIDATE_ONLY: "true" });
  const result = await g.send({ source: "opus" });
  assert.equal(result.ok, true);
  assert.equal(result.validateOnly, true);
  assert.equal(g.uploads[0].validateOnly, true);
});

function metaCapi(envOverrides = {}) {
  const events = [];
  const fetch = async (url, init) => {
    events.push(JSON.parse(init.body).data[0]);
    return { ok: true, status: 200, text: async () => JSON.stringify({ events_received: 1 }) };
  };
  const { sendMetaCapi } = loadTsModule(
    new URL("../src/lib/outbound/meta.ts", import.meta.url),
    { "../normalize": normalize, "../crypto": cryptoLib },
    {
      process: {
        env: { META_PIXEL_ID: "1", META_CAPI_ACCESS_TOKEN: "synthetic", ...envOverrides },
      },
      fetch,
    },
  );
  const send = (args = {}) =>
    sendMetaCapi({
      eventId: "opus_lesson-1",
      eventName: "TRIAL_BOOKED",
      eventTime: new Date("2026-11-04T18:22:05.000Z"),
      eventSourceUrl: "https://lessons.virtu.academy/trial",
      email: "parent@example.com",
      ...args,
    });
  return { send, events };
}

test("Opus events reach Meta under their own opus: name and never fall back", async () => {
  const mapped = metaCapi({
    META_CAPI_EVENT_NAMES: "TRIAL_BOOKED=StartTrial,opus:TRIAL_BOOKED=Purchase",
  });
  await mapped.send({ source: "opus", value: 24.5, currency: "usd" });
  await mapped.send({ eventId: "123" });
  assert.equal(mapped.events[0].event_name, "Purchase");
  assert.equal(mapped.events[0].event_id, "opus_lesson-1");
  assert.deepEqual({ ...mapped.events[0].custom_data }, { value: 24.5, currency: "USD" });
  assert.equal(mapped.events[1].event_name, "StartTrial");
  // An Acuity event with no entry of its own stays unsent, as before the opus: entry.
  const canceled = await mapped.send({ eventId: "123", eventName: "TRIAL_CANCELED" });
  assert.equal(canceled.skipped, true);
  assert.equal(mapped.events.length, 2);

  // No opus: entry: not Acuity's name, not META_CAPI_EVENT_NAME, not a built-in default.
  for (const env of [
    {},
    { META_CAPI_EVENT_NAMES: "TRIAL_BOOKED=StartTrial" },
    { META_CAPI_EVENT_NAME: "Lead" },
  ]) {
    const unmapped = metaCapi(env);
    const result = await unmapped.send({ source: "opus" });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /opus:TRIAL_BOOKED/);
    assert.equal(unmapped.events.length, 0);
  }
});

test("adding an opus: entry leaves Acuity's Meta event names as they were", async () => {
  // The built-in names Acuity events get when no name is configured for them.
  for (const [eventName, expected] of [
    ["TRIAL_BOOKED", "SubmitApplication"],
    ["APPOINTMENT_BOOKED", "Schedule"],
    ["TRIAL_CANCELED", "Cancel"],
  ]) {
    for (const env of [{}, { META_CAPI_EVENT_NAMES: "opus:TRIAL_BOOKED=Purchase" }]) {
      for (const source of [undefined, "acuity"]) {
        const m = metaCapi(env);
        await m.send({ eventId: "123", eventName, source });
        assert.equal(m.events[0].event_name, expected, eventName);
      }
    }
  }
});

// `options.event` overrides the canonical event, for one that is not a booking: it has no
// appointment, and `options.contact` is its EventContact row.
function worker(options = {}) {
  const appointmentId = options.appointmentId ?? "opus_lesson-1";
  const updates = [];
  const googleCalls = [];
  const hubspotCalls = [];
  const metaCalls = [];
  // The later, Google-only messages queued for uploads Google called too recent.
  const retries = [];
  const contactLookups = [];
  const errors = [];
  const sent = { skipped: false, ok: true, status: 200, body: "{}", requestBody: "{}" };
  const env = {
    QSTASH_CURRENT_SIGNING_KEY: "synthetic",
    QSTASH_NEXT_SIGNING_KEY: "synthetic",
    HUBSPOT_SOURCE_SYSTEM: "attrib.virtu.academy",
    OPUS_DELIVERY_PLATFORMS: options.opusPlatforms ?? "GOOGLE_ADS,HUBSPOT",
    ...options.env,
  };
  const prisma = {
    canonicalEvent: {
      findUnique: async () => ({
        id: "ce_1",
        name: "TRIAL_BOOKED",
        eventTime: new Date("2026-11-04T18:22:05.000Z"),
        appointmentId,
        eventId: appointmentId,
        attributionTok: appointmentId,
        value: 35,
        currency: "USD",
        deliveries: options.deliveries ?? [
          { id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 0 },
          { id: "hubspot", platform: "HUBSPOT", status: "PENDING", attempts: 0 },
          ...(options.extraDeliveries ?? []),
        ],
        ...options.event,
      }),
    },
    appointment: {
      findUnique: async ({ where }) => ({
        id: where.id,
        email: "parent@example.com",
        phone: "+15555550123",
        firstName: "Pat",
        lastName: "Example",
        gclid: "G-1",
        scheduledBy: options.scheduledBy ?? null,
      }),
    },
    attribution: {
      findUnique: async () => ({
        token: appointmentId,
        sessionId: null,
        ipAddress: "203.0.113.7",
        userAgent: "Synthetic-Agent",
        lastUrl: options.lastUrl ?? "https://app.fortelessons.com/teacher/profile/abc",
        gclid: "G-1",
        fbc: options.fbc ?? null,
        hubspotutk: options.hubspotutk ?? null,
      }),
    },
    session: {
      findUnique: async () => {
        throw new Error("No ingest session exists for these bookings");
      },
    },
    // Read only for an event with no appointment. A booking's delivery must work on a
    // database that does not have this table yet.
    eventContact: {
      findUnique: async ({ where }) => {
        contactLookups.push(where.canonicalEventId);
        if (!options.contact) throw new Error('relation "EventContact" does not exist');
        return options.contact;
      },
    },
    delivery: { update: async (update) => updates.push(update) },
  };
  // Other platforms record calls instead of throwing, so a test can prove none happened.
  const otherCalls = [];
  const unexpected = async (args) => {
    otherCalls.push(args);
    return { skipped: true, reason: "stub" };
  };
  const { POST } = loadTsModule(
    new URL("../src/app/api/qstash/deliver/route.ts", import.meta.url),
    {
      "next/server": {
        NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
      },
      "@upstash/qstash": {
        Receiver: class {
          async verify() {
            return true;
          }
        },
      },
      "@/lib/prisma": { prisma },
      "@/lib/bookingSource": bookingSource,
      "@/lib/qstash": {
        enqueuePlatformRetry: async (id, platform, notBefore) => {
          if (options.retryQueueFails) throw new Error("queue unavailable");
          retries.push({ id, platform, notBefore });
        },
      },
      "@/lib/outbound/googleAds": {
        sendGoogleAdsClickConversion: async (args) => {
          googleCalls.push(args);
          if (options.googleThrows) throw new Error("fetch failed");
          return { ...sent, validateOnly: false, ...options.google };
        },
      },
      "@/lib/outbound/hubspot": {
        sendHubSpotEvent: async (args) => {
          hubspotCalls.push(args);
          return { ...sent, ...options.hubspot };
        },
      },
      "@/lib/outbound/meta": {
        sendMetaCapi: async (args) => {
          metaCalls.push(args);
          return sent;
        },
      },
      "@/lib/outbound/tiktok": { sendTikTokEvent: unexpected },
      "@/lib/outbound/openai.mjs": {
        sendOpenAIConversion: unexpected,
        validateOpenAIConversion: unexpected,
      },
    },
    { process: { env }, console: { error: (...line) => errors.push(line) } },
  );
  const invoke = (message = { canonicalEventId: "ce_1" }) =>
    POST({
      text: async () => JSON.stringify(message),
      headers: new Headers({ "upstash-signature": "synthetic" }),
    });
  const statusOf = (id) => updates.find((u) => u.where.id === id)?.data;
  return {
    invoke,
    googleCalls,
    hubspotCalls,
    metaCalls,
    otherCalls,
    retries,
    contactLookups,
    errors,
    updates,
    statusOf,
  };
}

test("an Opus booking reaches Google Ads and HubSpot as an Opus conversion", async () => {
  const w = worker();
  assert.equal((await w.invoke()).status, 200);

  const [google] = w.googleCalls;
  assert.equal(google.source, "opus");
  assert.equal(google.eventId, "opus_lesson-1");
  assert.equal(google.gclid, "G-1");
  assert.equal(google.userIpAddress, "203.0.113.7");

  const [hubspot] = w.hubspotCalls;
  assert.equal(hubspot.sourceSystem, "opus");
  assert.equal(hubspot.email, "parent@example.com");
  assert.equal(hubspot.userAgent, "Synthetic-Agent");

  assert.equal(w.statusOf("google").status, "SUCCESS");
  assert.equal(w.statusOf("hubspot").status, "SUCCESS");
});

test("a Google or HubSpot outage or rate limit asks QStash to retry; a rejected upload does not", async () => {
  const cases = [
    ["Google 503", { google: { ok: false, status: 503 } }, 503],
    ["Google network error", { googleThrows: true }, 503],
    ["HubSpot 429", { hubspot: { ok: false, status: 429 } }, 503],
    [
      "Google rejects the click (partial failure, HTTP 200)",
      { google: { ok: false, status: 200 } },
      200,
    ],
    ["HubSpot 400", { hubspot: { ok: false, status: 400 } }, 200],
  ];
  for (const [name, options, expected] of cases) {
    const w = worker(options);
    assert.equal((await w.invoke()).status, expected, name);
    // Both platforms are attempted either way; the failure is recorded before any retry.
    assert.equal(w.googleCalls.length, 1, name);
    assert.equal(w.hubspotCalls.length, 1, name);
  }
});

test("Acuity bookings keep the Acuity source, HubSpot source system and session-only IP", async () => {
  const lastUrl = "https://virtu.academy/schedule?appointmentType=1&fbclid=IwAR-1#pick";
  const w = worker({
    appointmentId: "123",
    extraDeliveries: [{ id: "meta", platform: "META", status: "PENDING" }],
    lastUrl,
  });
  await w.invoke();
  assert.equal(w.googleCalls[0].source, "acuity");
  assert.equal(w.googleCalls[0].userIpAddress, null);
  assert.equal(w.hubspotCalls[0].sourceSystem, "attrib.virtu.academy");
  // Meta is not gated by OPUS_DELIVERY_PLATFORMS for Acuity, resolves Acuity's event name and
  // gets the page address as stored.
  assert.equal(w.metaCalls[0].source, "acuity");
  assert.equal(w.metaCalls[0].eventSourceUrl, lastUrl);
  assert.equal(w.statusOf("meta").status, "SUCCESS");
});

test("an Opus booking reaches Meta as an Opus event once META is enabled", async () => {
  const enabled = {
    opusPlatforms: "GOOGLE_ADS,HUBSPOT,META",
    fbc: "fb.1.1730000000000.IwAR-1",
    lastUrl: "https://lessons.virtu.academy/trial?email=parent%40example.com&fbclid=IwAR-1#faq",
  };
  const w = worker({
    ...enabled,
    extraDeliveries: [{ id: "meta", platform: "META", status: "PENDING" }],
  });
  assert.equal((await w.invoke()).status, 200);

  const [meta] = w.metaCalls;
  assert.equal(meta.source, "opus");
  assert.equal(meta.eventId, "opus_lesson-1");
  assert.equal(meta.eventName, "TRIAL_BOOKED");
  assert.equal(meta.email, "parent@example.com");
  assert.equal(meta.fbc, "fb.1.1730000000000.IwAR-1");
  assert.equal(meta.ip, "203.0.113.7");
  assert.equal(meta.value, 35);
  // The page address goes without its query string and fragment.
  assert.equal(meta.eventSourceUrl, "https://lessons.virtu.academy/trial");
  assert.equal(w.statusOf("meta").status, "SUCCESS");

  // A row recorded as SKIPPED (META off at booking) is never sent.
  const skipped = worker({
    ...enabled,
    extraDeliveries: [{ id: "meta", platform: "META", status: "SKIPPED" }],
  });
  await skipped.invoke();
  assert.equal(skipped.metaCalls.length, 0);
  assert.equal(skipped.statusOf("meta"), undefined);
});

test("an Opus event never reaches Meta while it is off, or any platform outside the Opus list", async () => {
  const w = worker({
    extraDeliveries: [
      { id: "meta", platform: "META", status: "PENDING" },
      { id: "tiktok", platform: "TIKTOK", status: "PENDING" },
    ],
  });
  await w.invoke();
  assert.equal(w.metaCalls.length + w.otherCalls.length, 0);
  for (const id of ["meta", "tiktok"]) {
    assert.equal(w.statusOf(id).status, "SKIPPED");
    assert.match(w.statusOf(id).responseBody, /OPUS_DELIVERY_PLATFORMS/);
  }
  assert.equal(w.statusOf("google").status, "SUCCESS");
});

test("an Opus platform switched off after recording is skipped at delivery time", async () => {
  const w = worker({ opusPlatforms: "HUBSPOT" });
  await w.invoke();
  assert.equal(w.googleCalls.length, 0);
  assert.equal(w.statusOf("google").status, "SKIPPED");
  assert.equal(w.statusOf("hubspot").status, "SUCCESS");
});

test("validate-only Google uploads are SKIPPED, not SUCCESS, for both booking systems", async () => {
  for (const appointmentId of ["opus_lesson-1", "123"]) {
    const w = worker({ appointmentId, google: { validateOnly: true } });
    await w.invoke();
    const google = w.statusOf("google");
    assert.equal(google.status, "SKIPPED");
    assert.match(google.responseBody, /^GOOGLE_ADS_VALIDATE_ONLY: /);
  }
  const failed = worker({ google: { ok: false, status: 400, validateOnly: true } });
  await failed.invoke();
  assert.equal(failed.statusOf("google").status, "FAILED");
});

test("staff-booked Opus trials are skipped without contacting any platform", async () => {
  const w = worker({ scheduledBy: "opus:staff" });
  const response = await w.invoke();
  assert.equal(response.body.skipReason, "scheduled_by_opus_staff");
  assert.equal(w.googleCalls.length + w.hubspotCalls.length, 0);
  assert.equal(w.statusOf("google").status, "SKIPPED");
  assert.match(w.statusOf("hubspot").responseBody, /booked by Forte staff in Opus/);
});

test("HubSpot gets the visitor's utk when the Opus booking was linked to an ingest row", async () => {
  const linked = worker({ hubspotutk: "utk-1" });
  await linked.invoke();
  assert.equal(linked.hubspotCalls[0].utk, "utk-1");
  assert.equal(linked.hubspotCalls[0].sourceSystem, "opus");

  const unlinked = worker();
  await unlinked.invoke();
  assert.equal(unlinked.hubspotCalls[0].utk, null);
});

// An event that is not a booking: no appointment, its contact details on an EventContact row.
const accountEvent = {
  name: "ACCOUNT_CREATED",
  appointmentId: null,
  eventId: "opus_account_user-1",
  attributionTok: "opus_account_user-1",
  value: 15,
};
const accountContact = {
  email: "new@example.com",
  phone: "+15555550199",
  firstName: "Sam",
  lastName: "Signup",
  staffInitiated: false,
};
const adDeliveries = [
  { id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 0 },
  { id: "meta", platform: "META", status: "PENDING", attempts: 0 },
];

test("an account reaches Google Ads and Meta from its own contact row, with no appointment", async () => {
  const w = worker({
    event: accountEvent,
    contact: accountContact,
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
    lastUrl: "https://lessons.virtu.academy/trial?fbclid=IwAR-1#faq",
  });
  assert.equal((await w.invoke()).status, 200);
  assert.deepEqual(w.contactLookups, ["ce_1"]);

  const [google] = w.googleCalls;
  assert.equal(google.source, "opus");
  assert.equal(google.eventName, "ACCOUNT_CREATED");
  assert.equal(google.eventId, "opus_account_user-1");
  assert.equal(google.email, "new@example.com");
  assert.equal(google.phone, "+15555550199");
  assert.equal(google.conversionValue, 15);

  const [meta] = w.metaCalls;
  assert.equal(meta.source, "opus");
  assert.equal(meta.eventName, "ACCOUNT_CREATED");
  assert.equal(meta.email, "new@example.com");
  assert.equal(meta.firstName, "Sam");
  assert.equal(meta.eventSourceUrl, "https://lessons.virtu.academy/trial");
  // Nothing that names an appointment.
  assert.deepEqual(Object.keys(meta.customData).sort(), [
    "utm_campaign",
    "utm_medium",
    "utm_source",
  ]);
  assert.equal(w.hubspotCalls.length, 0);
  assert.equal(w.statusOf("google").status, "SUCCESS");
  assert.equal(w.statusOf("meta").status, "SUCCESS");

  const staff = worker({
    event: accountEvent,
    contact: { ...accountContact, staffInitiated: true },
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
  });
  assert.equal((await staff.invoke()).body.skipReason, "created_by_opus_staff");
  assert.equal(staff.googleCalls.length + staff.metaCalls.length, 0);
  assert.equal(staff.statusOf("meta").status, "SKIPPED");
});

test("a booking is delivered without the contact table ever being read", async () => {
  // In this harness that table answers "does not exist" unless an event's contact is given,
  // as on a database the new tables have not reached yet.
  for (const appointmentId of ["opus_lesson-1", "123"]) {
    const w = worker({ appointmentId });
    assert.equal((await w.invoke()).status, 200, appointmentId);
    assert.equal(w.contactLookups.length, 0, appointmentId);
    assert.equal(w.statusOf("google").status, "SUCCESS", appointmentId);
    assert.equal(w.statusOf("hubspot").status, "SUCCESS", appointmentId);
  }
});

test("a page event obeys PAGE_DELIVERY_PLATFORMS, not the Opus setting", async () => {
  const event = { ...accountEvent, name: "CALLBACK_REQUESTED", eventId: "page_callback_1" };
  // Both platforms are on for Opus; only Meta is on for the page.
  const w = worker({
    event,
    contact: accountContact,
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
    env: { PAGE_DELIVERY_PLATFORMS: "META" },
  });
  await w.invoke();
  assert.equal(w.googleCalls.length, 0);
  assert.equal(w.statusOf("google").status, "SKIPPED");
  assert.match(w.statusOf("google").responseBody, /PAGE_DELIVERY_PLATFORMS/);
  assert.equal(w.metaCalls[0].source, "page");
  assert.equal(w.metaCalls[0].eventName, "CALLBACK_REQUESTED");
  assert.equal(w.metaCalls[0].email, "new@example.com");

  const off = worker({
    event,
    contact: accountContact,
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
  });
  await off.invoke();
  assert.equal(off.googleCalls.length + off.metaCalls.length, 0);
});

const RETRY_DELAY_MS = 375 * 60 * 1000;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const tooRecent = { google: { ok: false, status: 200, body: "{}", tooRecent: true } };
// A Google Ads delivery waiting for retry number `retry`, last tried `minutes` ago.
const waiting = (retry, minutes) => ({
  id: "google",
  platform: "GOOGLE_ADS",
  status: "PENDING",
  attempts: retry,
  lastAttemptAt: minutesAgo(minutes),
  responseBody: `TOO_RECENT_RETRY ${retry}/4 after 2026-11-20T23:00:00.000Z. {}`,
});

test("an upload Google calls too recent stays pending and is retried once, later, by a Google-only message", async () => {
  const w = worker(tooRecent);
  const before = Date.now();
  // Not a failure of this message: the queue is not asked to retry it.
  const response = await w.invoke();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);

  const google = w.statusOf("google");
  assert.equal(google.status, "PENDING");
  assert.match(google.responseBody, /^TOO_RECENT_RETRY 1\/4 /);
  assert.deepEqual({ ...google.attempts }, { increment: 1 });
  assert.ok(google.lastAttemptAt.getTime() >= before);
  // Only columns the Delivery table has always had.
  assert.deepEqual(Object.keys(google).sort(), [
    "attempts",
    "lastAttemptAt",
    "requestBody",
    "responseBody",
    "responseCode",
    "status",
  ]);

  // One message, for Google Ads only, six and a quarter hours after the refused attempt.
  assert.equal(w.retries.length, 1);
  assert.equal(w.retries[0].id, "ce_1");
  assert.equal(w.retries[0].platform, "GOOGLE_ADS");
  assert.equal(w.retries[0].notBefore.getTime(), google.lastAttemptAt.getTime() + RETRY_DELAY_MS);
  // The other platform went out as usual.
  assert.equal(w.statusOf("hubspot").status, "SUCCESS");
});

test("a delivery waiting for its retry is left alone by every run that comes before it is due", async () => {
  // A queue retry of the first message (HubSpot failed then), an hour after Google's refusal.
  const early = worker({
    deliveries: [waiting(1, 60), { id: "hubspot", platform: "HUBSPOT", status: "FAILED" }],
  });
  assert.equal((await early.invoke()).status, 200);
  assert.equal(early.googleCalls.length, 0);
  // Untouched: its attempts and its retry count are not used up.
  assert.equal(early.statusOf("google"), undefined);
  assert.equal(early.hubspotCalls.length, 1);

  // Its own Google-only message, were it to arrive early, leaves it alone too.
  const scopedEarly = worker({ deliveries: [waiting(1, 60)] });
  await scopedEarly.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
  assert.equal(scopedEarly.googleCalls.length, 0);

  // Due: the message scheduled for 6 h 15 min arrives, even a few minutes early by this clock.
  for (const minutes of [371, 375, 600]) {
    const due = worker({ deliveries: [waiting(1, minutes)] });
    await due.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
    assert.equal(due.googleCalls.length, 1, `${minutes} minutes`);
    assert.equal(due.statusOf("google").status, "SUCCESS", `${minutes} minutes`);
  }
});

test("a too-recent upload is retried four times, then fails", async () => {
  // Still too recent on its third retry: a fourth is queued.
  const third = worker({ ...tooRecent, deliveries: [waiting(3, 400)] });
  await third.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
  assert.equal(third.statusOf("google").status, "PENDING");
  assert.match(third.statusOf("google").responseBody, /^TOO_RECENT_RETRY 4\/4 /);
  assert.equal(third.retries.length, 1);

  // And on its fourth: no more.
  const fourth = worker({ ...tooRecent, deliveries: [waiting(4, 400)] });
  const response = await fourth.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
  assert.equal(response.status, 200);
  assert.equal(fourth.statusOf("google").status, "FAILED");
  // It keeps its count, so a later run that tries the failed delivery again starts no new round.
  assert.match(
    fourth.statusOf("google").responseBody,
    /^TOO_RECENT_RETRY 4\/4 used\. Still too recent for Google after 4 retries/,
  );
  assert.equal(fourth.retries.length, 0);
});

test("another failure between too-recent answers does not reset the count of retries", async () => {
  // The Google Ads delivery as each run leaves it, six and a half hours passing in between.
  let row = { id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 0 };
  let queuedRetries = 0;
  const run = async (options) => {
    const w = worker({ ...options, deliveries: [row] });
    const response = await w.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
    const { attempts, ...written } = w.statusOf("google");
    row = {
      ...row,
      ...written,
      attempts: row.attempts + attempts.increment,
      lastAttemptAt: minutesAgo(390),
    };
    queuedRetries += w.retries.length;
    return response;
  };
  const marker = () => row.responseBody.match(/^TOO_RECENT_RETRY \d\/4/)?.[0];

  await run(tooRecent);
  assert.deepEqual([row.status, marker()], ["PENDING", "TOO_RECENT_RETRY 1/4"]);

  // The retry meets an outage. The queue is asked to try again, and the count is kept.
  const outage = await run({ google: { ok: false, status: 503, body: "upstream unavailable" } });
  assert.equal(outage.status, 503);
  assert.deepEqual([row.status, marker()], ["FAILED", "TOO_RECENT_RETRY 1/4"]);
  assert.match(row.responseBody, /upstream unavailable/);

  // Too recent again: the second retry, not the first once more.
  await run(tooRecent);
  assert.deepEqual([row.status, marker()], ["PENDING", "TOO_RECENT_RETRY 2/4"]);

  // A thrown error and a rate limit in between change nothing either.
  await run({ googleThrows: true });
  assert.deepEqual([row.status, marker()], ["FAILED", "TOO_RECENT_RETRY 2/4"]);
  await run({ google: { ok: false, status: 429, body: "slow down" } });
  assert.deepEqual([row.status, marker()], ["FAILED", "TOO_RECENT_RETRY 2/4"]);

  await run(tooRecent);
  assert.equal(marker(), "TOO_RECENT_RETRY 3/4");
  await run(tooRecent);
  assert.deepEqual([row.status, marker()], ["PENDING", "TOO_RECENT_RETRY 4/4"]);

  // The fifth too-recent answer is the end, with four retries queued in all.
  const last = await run(tooRecent);
  assert.equal(last.status, 200);
  assert.equal(row.status, "FAILED");
  assert.match(row.responseBody, /Still too recent for Google after 4 retries/);
  assert.equal(queuedRetries, 4);

  // A delivery that goes through drops the marker.
  await run({});
  assert.equal(row.status, "SUCCESS");
  assert.equal(marker(), undefined);
});

test("a too-recent upload whose retry cannot be queued fails with the reason and an error line", async () => {
  const w = worker({ ...tooRecent, retryQueueFails: true });
  // Nothing would come of the queue retrying this message, so it is not asked to.
  assert.equal((await w.invoke()).status, 200);
  assert.equal(w.statusOf("google").status, "FAILED");
  assert.match(w.statusOf("google").responseBody, /its retry could not be queued/);
  assert.equal(w.errors.length, 1);
  assert.match(w.errors[0][0], /could not queue the retry/);
});

test("a Google-only message touches no other platform's deliveries", async () => {
  // HubSpot and Meta failed earlier. An unscoped run would send both again, and a HubSpot
  // event has no idempotency key.
  const deliveries = [
    waiting(1, 400),
    { id: "hubspot", platform: "HUBSPOT", status: "FAILED" },
    { id: "meta", platform: "META", status: "FAILED" },
  ];
  const scoped = worker({ deliveries, opusPlatforms: "GOOGLE_ADS,HUBSPOT,META" });
  assert.equal(
    (await scoped.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" })).status,
    200,
  );
  assert.equal(scoped.googleCalls.length, 1);
  assert.equal(scoped.hubspotCalls.length + scoped.metaCalls.length, 0);
  assert.deepEqual(
    scoped.updates.map((update) => update.where.id),
    ["google"],
  );

  // Staff bookings: the same boundary.
  const staff = worker({ deliveries, scheduledBy: "opus:staff" });
  await staff.invoke({ canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
  assert.deepEqual(
    staff.updates.map((update) => update.where.id),
    ["google"],
  );

  // The message format stays strict: one known platform, no other field.
  for (const message of [
    { canonicalEventId: "ce_1", platform: "HUBSPOT" },
    { canonicalEventId: "ce_1", platform: ["GOOGLE_ADS"] },
    { canonicalEventId: "ce_1", platform: "GOOGLE_ADS", force: true },
    { canonicalEventId: "ce_1", kind: "retry" },
  ]) {
    const refused = worker({ deliveries });
    assert.equal((await refused.invoke(message)).status, 400, JSON.stringify(message));
    assert.equal(refused.googleCalls.length + refused.updates.length, 0);
  }
});

test("the Google Ads adapter calls an answer too recent only when that is all Google objected to", async () => {
  const partialFailure = (...codes) => ({
    partialFailureError: {
      details: [{ errors: codes.map((code) => ({ errorCode: { conversionUploadError: code } })) }],
    },
  });
  for (const [codes, tooRecentExpected, okExpected] of [
    [["TOO_RECENT_EVENT"], true, false],
    [["TOO_RECENT_CONVERSION_ACTION"], true, false],
    [["TOO_RECENT_EVENT", "TOO_RECENT_CONVERSION_ACTION"], true, false],
    // Waiting would not cure these, so they are plain failures.
    [["TOO_RECENT_EVENT", "EXPIRED_EVENT"], false, false],
    [["EXPIRED_EVENT"], false, false],
    // Unchanged: an unmatched click still counts as delivered.
    [["CLICK_NOT_FOUND"], false, true],
  ]) {
    const result = await googleAds({}, partialFailure(...codes)).send();
    assert.equal(result.tooRecent, tooRecentExpected, codes.join("+"));
    assert.equal(result.ok, okExpected, codes.join("+"));
  }
  const accepted = await googleAds().send();
  assert.equal(accepted.tooRecent, false);
});
