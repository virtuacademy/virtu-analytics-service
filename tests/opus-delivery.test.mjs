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

// `options.event` overrides the canonical event, for one that is not a booking: no appointment,
// its contact details on `contact`.
function worker(options = {}) {
  const appointmentId = options.appointmentId ?? "opus_lesson-1";
  const updates = [];
  const googleCalls = [];
  const hubspotCalls = [];
  const metaCalls = [];
  const requeued = [];
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
      // The later message a held delivery is put back with.
      "@/lib/qstash": {
        enqueueDelivery: async (id, notBefore) => {
          if (options.requeueThrows) throw new Error("queue unavailable");
          requeued.push({ id, notBefore });
        },
      },
      "@/lib/googleAdsHold": loadTsModule(
        new URL("../src/lib/googleAdsHold.ts", import.meta.url),
        {},
        { process: { env } },
      ),
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
    { process: { env } },
  );
  const invoke = () =>
    POST({
      text: async () => JSON.stringify({ canonicalEventId: "ce_1" }),
      headers: new Headers({ "upstash-signature": "synthetic" }),
    });
  const statusOf = (id) => updates.find((u) => u.where.id === id)?.data;
  return { invoke, googleCalls, hubspotCalls, metaCalls, otherCalls, requeued, statusOf };
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

// An event that is not a booking: no appointment, its contact details on its own row.
const accountEvent = {
  name: "ACCOUNT_CREATED",
  appointmentId: null,
  eventId: "opus_account_user-1",
  attributionTok: "opus_account_user-1",
  value: 15,
  contact: {
    email: "new@example.com",
    phone: "+15555550199",
    firstName: "Sam",
    lastName: "Signup",
    staffInitiated: false,
  },
};
const adDeliveries = [
  { id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 0 },
  { id: "meta", platform: "META", status: "PENDING", attempts: 0 },
];

test("an account reaches Google Ads and Meta from its own contact row, with no appointment", async () => {
  const w = worker({
    event: accountEvent,
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
    lastUrl: "https://lessons.virtu.academy/trial?fbclid=IwAR-1#faq",
  });
  assert.equal((await w.invoke()).status, 200);

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
    event: { ...accountEvent, contact: { ...accountEvent.contact, staffInitiated: true } },
    deliveries: adDeliveries,
    opusPlatforms: "GOOGLE_ADS,META",
  });
  assert.equal((await staff.invoke()).body.skipReason, "created_by_opus_staff");
  assert.equal(staff.googleCalls.length + staff.metaCalls.length, 0);
  assert.equal(staff.statusOf("meta").status, "SKIPPED");
});

test("a page event obeys PAGE_DELIVERY_PLATFORMS, not the Opus setting", async () => {
  const event = { ...accountEvent, name: "CALLBACK_REQUESTED", eventId: "page_callback_1" };
  // Both platforms are on for Opus; only Meta is on for the page.
  const w = worker({
    event,
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

  const off = worker({ event, deliveries: adDeliveries, opusPlatforms: "GOOGLE_ADS,META" });
  await off.invoke();
  assert.equal(off.googleCalls.length + off.metaCalls.length, 0);
});

test("a held Google Ads delivery is left untouched for its later message", async () => {
  const inMinutes = (minutes) => new Date(Date.now() + minutes * 60 * 1000);
  const withGoogle = (notBefore) => ({
    deliveries: [
      { id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 0, notBefore },
      { id: "hubspot", platform: "HUBSPOT", status: "PENDING", attempts: 0 },
    ],
  });

  const held = worker(withGoogle(inMinutes(300)));
  assert.equal((await held.invoke()).status, 200);
  assert.equal(held.googleCalls.length, 0);
  // Not attempted, not failed, not skipped: still PENDING for the later message.
  assert.equal(held.statusOf("google"), undefined);
  assert.equal(held.statusOf("hubspot").status, "SUCCESS");

  // Its own message may arrive a little early by this server's clock, and must still send it.
  for (const notBefore of [inMinutes(1), inMinutes(-1)]) {
    const due = worker(withGoogle(notBefore));
    await due.invoke();
    assert.equal(due.googleCalls.length, 1);
    assert.equal(due.statusOf("google").status, "SUCCESS");
  }
});

test("Google's too-recent answer puts the delivery back for later instead of failing it", async () => {
  const tooRecent = { google: { ok: false, status: 200, body: "{}", tooRecent: true } };
  const HOLD_MS = 375 * 60 * 1000;

  const w = worker(tooRecent);
  const before = Date.now();
  assert.equal((await w.invoke()).status, 200);
  const google = w.statusOf("google");
  assert.equal(google.status, "PENDING");
  assert.match(google.responseBody, /TOO_RECENT_EVENT/);
  assert.ok(google.notBefore.getTime() >= before + HOLD_MS);
  assert.deepEqual(
    w.requeued.map((message) => [message.id, message.notBefore.getTime()]),
    [["ce_1", google.notBefore.getTime()]],
  );

  // No later message could be scheduled: fail it and ask the queue to retry this one.
  const unqueued = worker({ ...tooRecent, requeueThrows: true });
  assert.equal((await unqueued.invoke()).status, 503);
  assert.equal(unqueued.statusOf("google").status, "FAILED");

  // Not forever.
  const worn = worker({
    ...tooRecent,
    deliveries: [{ id: "google", platform: "GOOGLE_ADS", status: "PENDING", attempts: 4 }],
  });
  assert.equal((await worn.invoke()).status, 200);
  assert.equal(worn.statusOf("google").status, "FAILED");
  assert.equal(worn.requeued.length, 0);
});

test("the Google Ads adapter reports TOO_RECENT_EVENT apart from other rejections", async () => {
  const partialFailure = (code) => ({
    partialFailureError: {
      details: [{ errors: [{ errorCode: { conversionUploadError: code } }] }],
    },
  });
  const recent = await googleAds({}, partialFailure("TOO_RECENT_EVENT")).send();
  assert.equal(recent.ok, false);
  assert.equal(recent.tooRecent, true);

  const expired = await googleAds({}, partialFailure("EXPIRED_EVENT")).send();
  assert.equal(expired.ok, false);
  assert.equal(expired.tooRecent, false);

  // Unchanged: an unmatched click still counts as delivered.
  const unmatched = await googleAds({}, partialFailure("CLICK_NOT_FOUND")).send();
  assert.equal(unmatched.ok, true);
  assert.equal(unmatched.tooRecent, false);
});
