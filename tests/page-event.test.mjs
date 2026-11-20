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
const CALLER_IP = "203.0.113.7";
const HOLD_MS = 375 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const on = { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" };

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

// `options.earlier` is an event this visit already reported in the window; `fromThisAddress`
// is how many of this address's events were accepted for delivery in it, and `fromEveryone`
// how many page events it holds in all.
function endpoint(options = {}) {
  const committed = [];
  const queued = [];
  const errors = [];
  // What the transaction did before writing, in order, with what it asked for.
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
  const asked = (step, result) => async (args) => {
    steps.push([step, args?.where]);
    return result;
  };
  const prisma = {
    attribution: {
      findUnique: async ({ where }) =>
        (options.visits ?? { [VISIT]: visitRow })[where.token] ?? null,
    },
    // Writes become visible only when the callback resolves, like a rolled-back transaction.
    $transaction: async (run) => {
      const writes = [];
      const result = await run({
        $executeRaw: async (sql) => {
          steps.push(["lock", sql.join("")]);
          return 1;
        },
        eventContact: {
          findFirst: asked("sameVisit", options.earlier ?? null),
          count: asked("sameAddress", options.fromThisAddress ?? 0),
          create: write(writes, "eventContact"),
        },
        attribution: { create: write(writes, "attribution") },
        canonicalEvent: {
          count: asked("everyone", options.fromEveryone ?? 0),
          create: write(writes, "canonicalEvent", { id: "ce_1" }),
        },
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
      "@/lib/clientIp": lib("clientIp.ts"),
      "@/lib/attribToken": lib("attribToken.ts"),
      "@/lib/bookingSource": lib("bookingSource.ts"),
      "@/lib/adEvents": lib("adEvents.ts"),
      "@/lib/googleAdsHold": lib("googleAdsHold.ts"),
      "@/lib/qstash": { queueDeliveries: async (id) => queued.push(id) },
    },
    { process: { env }, console: { error: (...line) => errors.push(line) } },
  );
  const send = (body, origin = PAGE, headers = { "x-forwarded-for": `${CALLER_IP}, 10.0.0.1` }) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return POST({
      text: async () => raw,
      headers: new Headers({ ...headers, ...(origin ? { origin } : {}) }),
    });
  };
  const rows = (table) => committed.filter((w) => w.table === table).map((w) => w.data);
  const whereOf = (step) => steps.find(([name]) => name === step)?.[1];
  return { send, committed, queued, errors, rows, steps, whereOf };
}

const statuses = (e) => Array.from(e.rows("delivery")[0], (d) => [d.platform, d.status]);
const delivered = [
  ["GOOGLE_ADS", "PENDING"],
  ["META", "PENDING"],
];
// Every delivery row is SKIPPED for the same reason, and nothing is queued.
function assertNotDelivered(e, reason) {
  assert.equal(e.rows("canonicalEvent").length, 1);
  for (const delivery of e.rows("delivery")[0]) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, reason);
  }
  assert.equal(e.queued.length, 0);
}

test("a callback from the page is recorded as its own event and queued for Google Ads and Meta", async () => {
  const e = endpoint({ env: { ...on, EVENT_VALUES: "page:CALLBACK_REQUESTED=15" } });
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
      // The first forwarded address, as ingest takes it.
      ipAddress: CALLER_IP,
    },
  );

  assert.deepEqual(statuses(e), delivered);
  // The click is over six hours old, so nothing waits.
  assert.equal(e.rows("delivery")[0][0].notBefore, null);
  assert.deepEqual(e.queued, ["ce_1"]);
  assert.equal(e.errors.length, 0);
});

test("page deliveries stay off until PAGE_DELIVERY_PLATFORMS lists the platform", async () => {
  // The Opus setting says nothing about page events.
  const e = endpoint({ env: { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT,META" } });
  assert.equal((await e.send(callback())).status, 200);
  assertNotDelivered(e, /PAGE_DELIVERY_PLATFORMS/);
  assert.equal(e.rows("canonicalEvent")[0].value, null);
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
    // Keeps honest browsers on other sites out. A script can send any Origin.
    ["a site that is not listed", callback(), "https://example.com", 403],
    ["no Origin header", callback(), null, 403],
  ]) {
    const e = endpoint({ env: on });
    const response = await e.send(body, origin);
    assert.equal(response.status, status, name);
    assert.equal(response.body.ok, false, name);
    assert.equal(JSON.stringify(response.body).includes("example.com"), false, name);
    assert.equal(e.committed.length, 0, name);
    assert.equal(e.queued.length, 0, name);
  }
});

test("a second callback for the same visit within 24 hours is recorded but not delivered", async () => {
  const e = endpoint({ env: on, earlier: { canonicalEventId: "ce_earlier" } });
  const before = Date.now();
  assert.equal((await e.send(callback())).status, 200);
  assertNotDelivered(e, /^Duplicate/);

  // Page events are checked one at a time, so two requests cannot both pass a check.
  assert.deepEqual(
    e.steps.map(([step]) => step),
    ["lock", "sameVisit", "sameAddress", "everyone"],
  );
  assert.match(e.steps[0][1], /pg_advisory_xact_lock/);
  const where = e.whereOf("sameVisit");
  assert.equal(where.vaAttrib, VISIT);
  assert.equal(where.canonicalEvent.name, "CALLBACK_REQUESTED");
  assert.ok(Math.abs(where.canonicalEvent.eventTime.gt.getTime() - (before - DAY_MS)) < 5_000);
});

test("a visit not seen in the last 24 hours cannot report an event that is delivered", async () => {
  const visited = (minutes) => ({ [VISIT]: { ...visitRow, lastTouchAt: minutesAgo(minutes) } });
  const stale = endpoint({ env: on, visits: visited(25 * 60) });
  assert.equal((await stale.send(callback())).status, 200);
  assertNotDelivered(stale, /^Stale visit/);

  const recent = endpoint({ env: on, visits: visited(23 * 60) });
  await recent.send(callback());
  assert.deepEqual(statuses(recent), delivered);
});

test("one address gets a few delivered callbacks a day, and the rest are only recorded", async () => {
  const before = Date.now();
  const capped = endpoint({ env: on, fromThisAddress: 3 });
  assert.equal((await capped.send(callback())).status, 200);
  assertNotDelivered(capped, /^Limit reached: 3 .* one address .*PAGE_EVENT_DAILY_LIMIT_PER_IP/);

  // Counted: this caller's events of the last 24 hours that were accepted for delivery.
  const where = capped.whereOf("sameAddress");
  assert.equal(where.ipAddress, CALLER_IP);
  assert.equal(where.canonicalEvent.name, "CALLBACK_REQUESTED");
  assert.ok(Math.abs(where.canonicalEvent.eventTime.gt.getTime() - (before - DAY_MS)) < 5_000);
  assert.deepEqual(JSON.parse(JSON.stringify(where.canonicalEvent.deliveries)), {
    some: { status: { not: "SKIPPED" } },
  });

  const under = endpoint({ env: on, fromThisAddress: 2 });
  await under.send(callback());
  assert.deepEqual(statuses(under), delivered);

  // The setting moves the limit; requests with no address share one allowance.
  const raised = endpoint({
    env: { ...on, PAGE_EVENT_DAILY_LIMIT_PER_IP: "5" },
    fromThisAddress: 3,
  });
  await raised.send(callback());
  assert.deepEqual(statuses(raised), delivered);
  const noAddress = endpoint({ env: on });
  await noAddress.send(callback(), PAGE, {});
  assert.equal(noAddress.whereOf("sameAddress").ipAddress, null);
  assert.equal(noAddress.rows("eventContact")[0].ipAddress, null);
});

test("IPv6 callers are counted by their /64 network, so one network cannot rotate addresses", async () => {
  for (const [sent, countedAs] of [
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    // Another address of the same network, written short, in capitals, with a zone.
    ["2001:DB8:1:2::7%eth0", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"],
    // A different network.
    ["2001:db8:1:3::7", "2001:db8:1:3::/64"],
    ["::1", "0:0:0:0::/64"],
    // IPv4, also when written as IPv6, stays one address.
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["203.0.113.7", "203.0.113.7"],
    // Not an address: counted as it was sent.
    ["2001:db8::1::2", "2001:db8::1::2"],
  ]) {
    const e = endpoint({ env: on });
    await e.send(callback(), PAGE, { "x-forwarded-for": sent });
    assert.equal(e.whereOf("sameAddress").ipAddress, countedAs, sent);
    assert.equal(e.rows("eventContact")[0].ipAddress, countedAs, sent);
  }
});

test("past the daily alert threshold an error is logged and the event is still delivered", async () => {
  // The 26th page event of the last 24 hours, whoever sent the others.
  const busy = endpoint({ env: on, fromEveryone: 25 });
  assert.equal((await busy.send(callback())).status, 200);
  // Other visitors' traffic never refuses an event: a shared limit would let a few forged
  // requests a day stop every real callback.
  assert.deepEqual(statuses(busy), delivered);
  assert.deepEqual(busy.queued, ["ce_1"]);
  // The line monitoring looks for, naming the switch that stops a flood.
  assert.equal(busy.errors.length, 1);
  assert.match(busy.errors[0][0], /^\[page-events\] 26 page events in 24 hours/);
  assert.match(busy.errors[0][0], /PAGE_EVENT_DAILY_ALERT_THRESHOLD \(25\)/);
  assert.match(busy.errors[0][0], /PAGE_DELIVERY_PLATFORMS/);
  assert.equal(JSON.stringify(busy.errors).includes("parent@example.com"), false);

  // Counted: every page event of the last 24 hours, refused ones included.
  const where = busy.whereOf("everyone");
  assert.deepEqual(JSON.parse(JSON.stringify(where.name)), { in: ["CALLBACK_REQUESTED"] });
  assert.equal(where.deliveries, undefined);

  const quiet = endpoint({ env: on, fromEveryone: 24 });
  await quiet.send(callback());
  assert.deepEqual(statuses(quiet), delivered);
  assert.equal(quiet.errors.length, 0);

  // The setting moves the threshold.
  const lowered = endpoint({
    env: { ...on, PAGE_EVENT_DAILY_ALERT_THRESHOLD: "2" },
    fromEveryone: 2,
  });
  await lowered.send(callback());
  assert.deepEqual(statuses(lowered), delivered);
  assert.match(lowered.errors[0][0], /^\[page-events\] 3 page events/);
});

test("a callback minutes after the ad click holds its Google Ads delivery", async () => {
  const lastTouchAt = minutesAgo(4);
  const e = endpoint({ env: on, visits: { [VISIT]: { ...visitRow, lastTouchAt } } });
  await e.send(callback());
  const [google, meta] = e.rows("delivery")[0];
  assert.equal(google.notBefore.getTime(), lastTouchAt.getTime() + HOLD_MS);
  assert.equal(meta.notBefore, null);
  assert.deepEqual(e.queued, ["ce_1"]);
});

test("a callback with no click ID and no email or phone is recorded but not delivered", async () => {
  const organic = { [VISIT]: { ...visitRow, gclid: null } };

  const nothing = endpoint({ env: on, visits: organic });
  await nothing.send(callback({ contact: { email: " ", firstName: "Pat" } }));
  assertNotDelivered(nothing, /No click ID and no contact details/);

  // The form's email is enough for a visitor no ad click identifies.
  const withEmail = endpoint({ env: on, visits: organic });
  await withEmail.send(callback());
  assert.deepEqual(statuses(withEmail), delivered);
});
