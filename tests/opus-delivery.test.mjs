import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// Opus bookings through the real Google Ads adapter and QStash worker, with every
// network and database boundary stubbed. Contract: docs/opus-trial-webhook.md.

const cryptoLib = loadTsModule(new URL("../src/lib/crypto.ts", import.meta.url), {
  crypto: nodeCrypto,
});
const bookingSource = loadTsModule(new URL("../src/lib/bookingSource.ts", import.meta.url), {});

const googleEnv = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "synthetic-dev-token",
  GOOGLE_ADS_CLIENT_ID: "synthetic-client",
  GOOGLE_ADS_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "synthetic-refresh",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
  GOOGLE_ADS_CONVERSION_ACTION_ID: "999",
  GOOGLE_ADS_CONVERSION_ACTIONS: "TRIAL_BOOKED=111,opus:TRIAL_BOOKED=222",
};

function googleAds(envOverrides = {}) {
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
    return { ok: true, status: 200, text: async () => "{}" };
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

function worker(options = {}) {
  const appointmentId = options.appointmentId ?? "opus_lesson-1";
  const updates = [];
  const googleCalls = [];
  const hubspotCalls = [];
  const sent = { skipped: false, ok: true, status: 200, body: "{}", requestBody: "{}" };
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
        deliveries: [
          { id: "google", platform: "GOOGLE_ADS", status: "PENDING" },
          { id: "hubspot", platform: "HUBSPOT", status: "PENDING" },
          ...(options.extraDeliveries ?? []),
        ],
      }),
    },
    appointment: {
      findUnique: async () => ({
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
        lastUrl: "https://app.fortelessons.com/teacher/profile/abc",
        gclid: "G-1",
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
      "@/lib/outbound/googleAds": {
        sendGoogleAdsClickConversion: async (args) => {
          googleCalls.push(args);
          return { ...sent, validateOnly: false, ...options.google };
        },
      },
      "@/lib/outbound/hubspot": {
        sendHubSpotEvent: async (args) => {
          hubspotCalls.push(args);
          return sent;
        },
      },
      "@/lib/outbound/meta": { sendMetaCapi: unexpected },
      "@/lib/outbound/tiktok": { sendTikTokEvent: unexpected },
      "@/lib/outbound/openai.mjs": {
        sendOpenAIConversion: unexpected,
        validateOpenAIConversion: unexpected,
      },
    },
    {
      process: {
        env: {
          QSTASH_CURRENT_SIGNING_KEY: "synthetic",
          QSTASH_NEXT_SIGNING_KEY: "synthetic",
          HUBSPOT_SOURCE_SYSTEM: "attrib.virtu.academy",
          OPUS_DELIVERY_PLATFORMS: options.opusPlatforms ?? "GOOGLE_ADS,HUBSPOT",
        },
      },
    },
  );
  const invoke = () =>
    POST({
      text: async () => JSON.stringify({ canonicalEventId: "ce_1" }),
      headers: new Headers({ "upstash-signature": "synthetic" }),
    });
  const statusOf = (id) => updates.find((u) => u.where.id === id)?.data;
  return { invoke, googleCalls, hubspotCalls, otherCalls, statusOf };
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

test("Acuity bookings keep the Acuity source, HubSpot source system and session-only IP", async () => {
  const w = worker({ appointmentId: "123" });
  await w.invoke();
  assert.equal(w.googleCalls[0].source, "acuity");
  assert.equal(w.googleCalls[0].userIpAddress, null);
  assert.equal(w.hubspotCalls[0].sourceSystem, "attrib.virtu.academy");
});

test("an Opus event never reaches a platform outside Google Ads and HubSpot", async () => {
  const w = worker({ extraDeliveries: [{ id: "meta", platform: "META", status: "PENDING" }] });
  await w.invoke();
  assert.equal(w.otherCalls.length, 0);
  assert.equal(w.statusOf("meta").status, "SKIPPED");
  assert.match(w.statusOf("meta").responseBody, /OPUS_DELIVERY_PLATFORMS/);
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
