import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real /api/attrib/event route against an in-memory transaction and queue.
// Contract: docs/page-events.md.

const require = createRequire(import.meta.url);
const zod = require("zod");

const PAGE = "https://lessons.virtu.academy";
const VISIT = "0b6c5a1e-3f4d-4c2b-9a8e-7d6f5e4c3b2a";
const HOLD_MS = 375 * 60 * 1000;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

// A visit that came from a Google ad long enough ago for Google to accept an upload.
const visitRow = {
  token: VISIT,
  createdAt: minutesAgo(600),
  firstTouchAt: minutesAgo(600),
  lastTouchAt: minutesAgo(500),
  firstUrl: "https://lessons.virtu.academy/trial?gclid=G-1",
  lastUrl: "https://lessons.virtu.academy/trial",
  gclid: "G-1",
  fbclid: null,
  fbc: null,
  sessionId: "session-1",
};

const callback = (overrides = {}) => ({
  type: "callback.requested",
  attribTok: VISIT,
  contact: { email: "parent@example.com", phone: "(555) 555-0123", firstName: "Pat" },
  ...overrides,
});

function endpoint(options = {}) {
  const committed = [];
  const queued = [];
  // What the transaction did, in order: the lock, then the 24-hour lookup.
  const steps = [];
  const env = { ALLOWED_ORIGINS: `https://virtu.academy,${PAGE}`, ...options.env };
  const lib = (file, dependencies = {}) =>
    loadTsModule(new URL(`../src/lib/${file}`, import.meta.url), dependencies, {
      process: { env },
    });
  const write = (writes, table, result) => async (args) => {
    writes.push({ table, data: args.data });
    return result;
  };
  const prisma = {
    attribution: {
      findUnique: async ({ where }) =>
        (options.visits ?? { [VISIT]: visitRow })[where.token] ?? null,
    },
    // Writes become visible only when the callback resolves, like a rolled-back transaction.
    $transaction: async (callback) => {
      const writes = [];
      const result = await callback({
        $queryRaw: async (_sql, token) => {
          steps.push(["lock", token]);
          return [];
        },
        eventContact: {
          findFirst: async ({ where }) => {
            steps.push(["lookup", where]);
            return options.earlier ?? null;
          },
          create: write(writes, "eventContact"),
        },
        attribution: { create: write(writes, "attribution") },
        canonicalEvent: { create: write(writes, "canonicalEvent", { id: "ce_1" }) },
        delivery: { createMany: write(writes, "delivery") },
      });
      committed.push(...writes);
      return result;
    },
  };
  const { POST } = loadTsModule(
    new URL("../src/app/api/attrib/event/route.ts", import.meta.url),
    {
      "next/server": {
        NextResponse: {
          json: (body, init) => ({ body, status: init?.status ?? 200, headers: new Headers() }),
        },
      },
      zod,
      "@/lib/prisma": { prisma },
      "@/lib/crypto": loadTsModule(new URL("../src/lib/crypto.ts", import.meta.url), {
        crypto: nodeCrypto,
      }),
      "@/lib/cors": lib("cors.ts"),
      "@/lib/attribToken": lib("attribToken.ts"),
      "@/lib/bookingSource": lib("bookingSource.ts"),
      "@/lib/adEvents": lib("adEvents.ts"),
      "@/lib/googleAdsHold": lib("googleAdsHold.ts"),
      "@/lib/qstash": { queueDeliveries: async (id) => queued.push(id) },
    },
    { process: { env } },
  );
  const send = (body, origin = PAGE) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return POST({ text: async () => raw, headers: new Headers(origin ? { origin } : {}) });
  };
  const rows = (table) => committed.filter((w) => w.table === table).map((w) => w.data);
  return { send, committed, queued, rows, steps };
}

const statuses = (e) => Array.from(e.rows("delivery")[0], (d) => [d.platform, d.status]);

test("a callback from the page is recorded as its own event and queued for Google Ads and Meta", async () => {
  const e = endpoint({
    env: {
      PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META",
      EVENT_VALUES: "page:CALLBACK_REQUESTED=15",
    },
  });
  const response = await e.send(callback());
  assert.equal(response.status, 200);
  // Nothing the caller sent, and no ID, comes back.
  assert.deepEqual({ ...response.body }, { ok: true });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGE);

  // The visit frozen under the event's own token, so later page views cannot change it.
  const [snapshot] = e.rows("attribution");
  assert.match(snapshot.token, /^page_callback_[0-9a-f-]{36}$/);
  assert.equal(snapshot.gclid, "G-1");
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.createdAt, undefined);

  const [event] = e.rows("canonicalEvent");
  assert.equal(event.name, "CALLBACK_REQUESTED");
  assert.equal(event.eventId, snapshot.token);
  assert.equal(event.attributionTok, snapshot.token);
  assert.equal(event.appointmentId, undefined);
  assert.equal(event.value, 15);
  assert.equal(event.currency, "USD");

  assert.deepEqual(
    { ...e.rows("eventContact")[0] },
    {
      canonicalEventId: "ce_1",
      email: "parent@example.com",
      phone: "(555) 555-0123",
      firstName: "Pat",
      vaAttrib: VISIT,
    },
  );

  assert.deepEqual(statuses(e), [
    ["GOOGLE_ADS", "PENDING"],
    ["META", "PENDING"],
  ]);
  // The click is over six hours old, so nothing waits.
  assert.equal(e.rows("delivery")[0][0].notBefore, null);
  assert.deepEqual(e.queued, ["ce_1"]);
});

test("page deliveries stay off until PAGE_DELIVERY_PLATFORMS lists the platform", async () => {
  // The Opus setting says nothing about page events.
  const e = endpoint({ env: { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT,META" } });
  assert.equal((await e.send(callback())).status, 200);
  for (const delivery of e.rows("delivery")[0]) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, /PAGE_DELIVERY_PLATFORMS/);
  }
  assert.equal(e.rows("canonicalEvent")[0].value, null);
  assert.equal(e.queued.length, 0);
});

test("an unknown visit, another site and a body outside the contract are refused without writes", async () => {
  const unknown = "11111111-2222-4333-8444-555555555555";
  for (const [name, body, origin, status] of [
    ["a token no visit has", callback({ attribTok: unknown }), PAGE, 404],
    ["an Opus event's token", callback({ attribTok: "opus_lesson-1" }), PAGE, 400],
    ["another page event's token", callback({ attribTok: "page_callback_1" }), PAGE, 400],
    ["no token", callback({ attribTok: undefined }), PAGE, 400],
    ["another event type", callback({ type: "trial.booked" }), PAGE, 400],
    ["an over-long email", callback({ contact: { email: `${"x".repeat(250)}@a.co` } }), PAGE, 400],
    ["not JSON", "callback", PAGE, 400],
    ["an oversized body", callback({ notes: "x".repeat(3000) }), PAGE, 413],
    ["a site that is not allowed", callback(), "https://example.com", 403],
    ["no Origin header", callback(), null, 403],
  ]) {
    const e = endpoint({ env: { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" } });
    const response = await e.send(body, origin);
    assert.equal(response.status, status, name);
    assert.equal(response.body.ok, false, name);
    assert.equal(JSON.stringify(response.body).includes("example.com"), false, name);
    assert.equal(e.committed.length, 0, name);
    assert.equal(e.queued.length, 0, name);
  }
});

test("a second callback for the same visit within 24 hours is recorded but not delivered", async () => {
  const e = endpoint({
    env: { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" },
    earlier: { canonicalEventId: "ce_earlier" },
  });
  const before = Date.now();
  assert.equal((await e.send(callback())).status, 200);

  assert.equal(e.rows("canonicalEvent").length, 1);
  for (const delivery of e.rows("delivery")[0]) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, /^Duplicate/);
  }
  assert.equal(e.queued.length, 0);

  // Requests for one visit take turns before the lookup, so two cannot both pass it.
  assert.deepEqual(
    e.steps.map(([step]) => step),
    ["lock", "lookup"],
  );
  assert.equal(e.steps[0][1], VISIT);
  const where = e.steps[1][1];
  assert.equal(where.vaAttrib, VISIT);
  assert.equal(where.canonicalEvent.name, "CALLBACK_REQUESTED");
  const since = where.canonicalEvent.eventTime.gt.getTime();
  assert.ok(Math.abs(since - (before - 24 * 60 * 60 * 1000)) < 5_000);
});

test("a callback minutes after the ad click holds its Google Ads delivery", async () => {
  const lastTouchAt = minutesAgo(4);
  const e = endpoint({
    env: { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" },
    visits: { [VISIT]: { ...visitRow, lastTouchAt } },
  });
  await e.send(callback());
  const [google, meta] = e.rows("delivery")[0];
  assert.equal(google.notBefore.getTime(), lastTouchAt.getTime() + HOLD_MS);
  assert.equal(meta.notBefore, null);
  assert.deepEqual(e.queued, ["ce_1"]);
});

test("a callback with no click ID and no email or phone is recorded but not delivered", async () => {
  const env = { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" };
  const organic = { [VISIT]: { ...visitRow, gclid: null } };

  const nothing = endpoint({ env, visits: organic });
  await nothing.send(callback({ contact: { email: " ", firstName: "Pat" } }));
  for (const delivery of nothing.rows("delivery")[0]) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, /No click ID and no contact details/);
  }
  assert.equal(nothing.queued.length, 0);

  // The form's email is enough for a visitor no ad click identifies.
  const withEmail = endpoint({ env, visits: organic });
  await withEmail.send(callback());
  assert.deepEqual(statuses(withEmail), [
    ["GOOGLE_ADS", "PENDING"],
    ["META", "PENDING"],
  ]);
});
