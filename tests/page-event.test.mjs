import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real /api/attrib/event route against an in-memory database whose transactions and
// advisory locks behave like PostgreSQL's: writes show only once committed, and a lock has one
// holder at a time until its transaction ends. Contract: docs/page-events.md.

const require = createRequire(import.meta.url);
const zod = require("zod");

const PAGE = "https://lessons.virtu.academy";
const CALLER_IP = "203.0.113.7";
const DAY_MINUTES = 24 * 60;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
const on = { PAGE_DELIVERY_PLATFORMS: "GOOGLE_ADS,META" };

// A visit that came from a Google ad, seen a few minutes ago.
const visitToken = (n) => `0b6c5a1e-3f4d-4c2b-9a8e-${String(n).padStart(12, "0")}`;
const visit = (n, more = {}) => ({
  token: visitToken(n),
  createdAt: minutesAgo(30),
  firstTouchAt: minutesAgo(30),
  lastTouchAt: minutesAgo(5),
  firstUrl: "https://lessons.virtu.academy/trial?gclid=G-1",
  lastUrl: "https://lessons.virtu.academy/trial",
  gclid: "G-1",
  fbclid: null,
  fbc: null,
  sessionId: "session-1",
  ...more,
});
const VISIT = visitToken(1);

const callback = (overrides = {}) => ({
  type: "callback.requested",
  attribTok: VISIT,
  contact: { email: "parent@example.com", phone: "(555) 555-0123", firstName: "Pat" },
  ...overrides,
});

// `options.visits` are the recorded visits (visit 1 by default). `options.accepted` are
// callbacks accepted earlier: `{ vaAttrib, ipAddress, minutesAgo }`, each defaulting to a
// visit and an address of its own, an hour ago. `options.duringTransaction` runs inside a
// request's transaction, after its locks and checks, to hold it there.
function endpoint(options = {}) {
  const env = { ALLOWED_ORIGINS: `https://virtu.academy,${PAGE}`, ...options.env };
  const visits = Object.fromEntries((options.visits ?? [visit(1)]).map((row) => [row.token, row]));
  // The committed database.
  const db = { attributions: [], events: [], contacts: [], deliveries: [] };
  let rowNumber = 0;
  for (const earlier of options.accepted ?? []) {
    const id = `ce_earlier_${++rowNumber}`;
    db.events.push({
      id,
      name: "CALLBACK_REQUESTED",
      eventTime: minutesAgo(earlier.minutesAgo ?? 60),
    });
    db.contacts.push({
      canonicalEventId: id,
      vaAttrib: earlier.vaAttrib ?? `earlier-visit-${rowNumber}`,
      ipAddress: "ipAddress" in earlier ? earlier.ipAddress : `198.51.100.${rowNumber}`,
    });
  }
  const seeded = { events: db.events.length, contacts: db.contacts.length };
  const queued = [];
  const warnings = [];
  const errors = [];
  const lockKeys = [];
  let transactions = 0;
  let databaseCalls = 0;

  // Advisory locks: one holder per key, the next waits for it.
  const lockTails = new Map();
  const acquire = (key) => {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => (release = resolve));
    lockTails.set(
      key,
      previous.then(() => held),
    );
    return previous.then(() => release);
  };

  const contactsWhere = (where) =>
    db.contacts.filter((contact) => {
      const event = db.events.find((row) => row.id === contact.canonicalEventId);
      return (
        (!("vaAttrib" in where) || contact.vaAttrib === where.vaAttrib) &&
        (!("ipAddress" in where) || contact.ipAddress === where.ipAddress) &&
        event.name === where.canonicalEvent.name &&
        event.eventTime > where.canonicalEvent.eventTime.gt
      );
    });
  // Every read sees committed rows only.
  const contactReads = {
    findFirst: async ({ where }) => {
      databaseCalls += 1;
      return contactsWhere(where)[0] ?? null;
    },
    count: async ({ where }) => {
      databaseCalls += 1;
      return contactsWhere(where).length;
    },
  };
  const prisma = {
    attribution: {
      findUnique: async ({ where }) => {
        databaseCalls += 1;
        return visits[where.token] ?? null;
      },
    },
    eventContact: contactReads,
    canonicalEvent: {
      count: async ({ where }) => {
        databaseCalls += 1;
        return db.events.filter(
          (event) => where.name.in.includes(event.name) && event.eventTime > where.eventTime.gt,
        ).length;
      },
    },
    $transaction: async (run) => {
      databaseCalls += 1;
      transactions += 1;
      const releases = [];
      const writes = { attributions: [], events: [], contacts: [], deliveries: [] };
      try {
        const result = await run({
          $executeRaw: async (sql, value) => {
            const key = `${sql.join("?")} ${value}`;
            lockKeys.push(key);
            releases.push(await acquire(key));
            return 1;
          },
          eventContact: {
            ...contactReads,
            create: async ({ data }) => writes.contacts.push(data),
          },
          attribution: {
            create: async ({ data }) => {
              await options.duringTransaction?.(data);
              await tick();
              writes.attributions.push(data);
            },
          },
          canonicalEvent: {
            create: async ({ data }) => {
              const row = { id: `ce_${++rowNumber}`, ...data };
              writes.events.push(row);
              return row;
            },
          },
          delivery: { createMany: async ({ data }) => writes.deliveries.push(...data) },
        });
        for (const table of Object.keys(writes)) db[table].push(...writes[table]);
        return result;
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  };

  const lib = (file) =>
    loadTsModule(new URL(`../src/lib/${file}`, import.meta.url), {}, { process: { env } });
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
      "@/lib/qstash": { enqueueDelivery: async (id) => queued.push(id) },
    },
    {
      process: { env },
      console: {
        warn: (...line) => warnings.push(line),
        error: (...line) => errors.push(line),
      },
    },
  );
  const send = (body, { origin = PAGE, ip = CALLER_IP } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return POST({
      text: async () => raw,
      headers: new Headers({
        ...(ip ? { "x-forwarded-for": `${ip}, 10.0.0.1` } : {}),
        ...(origin ? { origin } : {}),
      }),
    });
  };
  // What this endpoint added to the database since the test began.
  const added = () => ({
    attributions: db.attributions,
    events: db.events.slice(seeded.events),
    contacts: db.contacts.slice(seeded.contacts),
    deliveries: db.deliveries,
  });
  const wroteNothing = () => Object.values(added()).every((rows) => rows.length === 0);
  return {
    send,
    added,
    wroteNothing,
    queued,
    warnings,
    errors,
    lockKeys,
    transactions: () => transactions,
    databaseCalls: () => databaseCalls,
  };
}

const statuses = (e) => e.added().deliveries.map((d) => [d.platform, d.status]);
const delivered = [
  ["GOOGLE_ADS", "PENDING"],
  ["META", "PENDING"],
];

test("a callback from the page is recorded as its own event and queued for Google Ads and Meta", async () => {
  const e = endpoint({ env: { ...on, EVENT_VALUES: "page:CALLBACK_REQUESTED=15" } });
  const response = await e.send(callback());
  assert.equal(response.status, 200);
  // Nothing the caller sent, and no ID, comes back.
  assert.deepEqual({ ...response.body }, { ok: true });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), PAGE);

  const { attributions, events, contacts, deliveries } = e.added();
  // The visit frozen under the event's own token, so later page views cannot change it.
  const [snapshot] = attributions;
  assert.match(snapshot.token, /^page_callback_[0-9a-f-]{36}$/);
  assert.equal(snapshot.gclid, "G-1");
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.createdAt, undefined);

  const [event] = events;
  assert.equal(event.name, "CALLBACK_REQUESTED");
  assert.equal(event.eventId, snapshot.token);
  assert.equal(event.attributionTok, snapshot.token);
  assert.equal(event.appointmentId, undefined);
  assert.equal(event.value, 15);
  assert.equal(event.currency, "USD");

  assert.deepEqual(
    { ...contacts[0] },
    {
      canonicalEventId: event.id,
      email: "parent@example.com",
      phone: "(555) 555-0123",
      firstName: "Pat",
      vaAttrib: VISIT,
      // The first forwarded address, as ingest takes it.
      ipAddress: CALLER_IP,
    },
  );

  assert.deepEqual(statuses(e), delivered);
  // Only columns the Delivery table has always had: nothing is held back.
  for (const delivery of deliveries) {
    assert.deepEqual(Object.keys(delivery).sort(), [
      "canonicalEventId",
      "platform",
      "responseBody",
      "status",
    ]);
  }
  assert.deepEqual(e.queued, [event.id]);
  assert.equal(e.warnings.length + e.errors.length, 0);
  // The visit's lock, then the address's: always in that order.
  assert.equal(e.lockKeys.length, 2);
  assert.match(e.lockKeys[0], /pg_advisory_xact_lock\(731620, hashtext\(\?\)\)/);
  assert.ok(e.lockKeys[0].endsWith(VISIT));
  assert.match(e.lockKeys[1], /pg_advisory_xact_lock\(731621, hashtext\(\?\)\)/);
  assert.ok(e.lockKeys[1].endsWith(CALLER_IP));
});

test("page deliveries stay off until PAGE_DELIVERY_PLATFORMS lists the platform", async () => {
  // The Opus setting says nothing about page events.
  const e = endpoint({ env: { OPUS_DELIVERY_PLATFORMS: "GOOGLE_ADS,HUBSPOT,META" } });
  assert.equal((await e.send(callback())).status, 200);
  // Recorded, so the rules per visit and per address still count it, and delivered nowhere.
  assert.equal(e.added().events.length, 1);
  for (const delivery of e.added().deliveries) {
    assert.equal(delivery.status, "SKIPPED");
    assert.match(delivery.responseBody, /PAGE_DELIVERY_PLATFORMS/);
  }
  assert.equal(e.added().events[0].value, null);
  assert.equal(e.queued.length, 0);
});

test("an unknown visit, another site and a body outside the contract are refused without writes", async () => {
  for (const [name, body, origin, status] of [
    ["a token no visit has", callback({ attribTok: visitToken(999) }), PAGE, 404],
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
    const response = await e.send(body, { origin });
    assert.equal(response.status, status, name);
    assert.equal(response.body.ok, false, name);
    assert.equal(JSON.stringify(response.body).includes("example.com"), false, name);
    assert.ok(e.wroteNothing(), name);
    assert.equal(e.transactions(), 0, name);
    assert.equal(e.queued.length, 0, name);
  }
});

test("contact text the database cannot store is a 400 before any database work", async () => {
  // A NUL, another control character, or half of a surrogate pair. PostgreSQL refuses the
  // first and the last, and only inside the transaction: after the locks, with nothing
  // recorded, so no rule would ever start refusing a script that repeats it.
  for (const [name, contact] of [
    ["a NUL in the email", { email: "a\u0000b@example.com" }],
    ["a NUL in the phone", { email: "parent@example.com", phone: "555\u0000" }],
    ["a control character in the phone", { email: "parent@example.com", phone: "555\u0007555" }],
    [
      "a line break inside the first name",
      { email: "parent@example.com", firstName: "Pat\nSmith" },
    ],
    ["a lone high surrogate", { email: "parent@example.com", firstName: "Pat\uD83C" }],
    ["a lone low surrogate", { email: "parent@example.com", firstName: "\uDFB9Pat" }],
  ]) {
    const e = endpoint({ env: on });
    const response = await e.send(callback({ contact }));
    assert.equal(response.status, 400, name);
    assert.equal(response.body.ok, false, name);
    assert.equal(e.databaseCalls(), 0, name);
    assert.ok(e.wroteNothing(), name);
  }

  // Ordinary text passes: accents, a whole emoji, and white space around a value.
  for (const contact of [
    { email: "zoe@example.com", firstName: "Zoë Müller" },
    { email: "parent@example.com", firstName: "Pat 🎹" },
    { email: " parent@example.com\n", phone: "\t(555) 555-0123 ", firstName: "Pat" },
  ]) {
    const e = endpoint({ env: on });
    assert.equal((await e.send(callback({ contact }))).status, 200);
    assert.equal(e.added().events.length, 1, JSON.stringify(contact));
  }
});

test("a request a rule refuses writes nothing, takes no lock and is logged without anything personal", async () => {
  const fromCaller = { ipAddress: CALLER_IP };
  for (const [name, options, body, reason] of [
    [
      "a visit last seen over 24 hours ago",
      { visits: [visit(1, { lastTouchAt: minutesAgo(DAY_MINUTES + 60) })] },
      callback(),
      /last seen more than 24 hours ago/,
    ],
    [
      "nothing to match it with",
      { visits: [visit(1, { gclid: null })] },
      callback({ contact: { email: " ", firstName: "Pat" } }),
      /no click ID and no email or phone/,
    ],
    [
      "a second callback for the visit",
      { accepted: [{ vaAttrib: VISIT }] },
      callback(),
      /visit already reported one in the last 24 hours/,
    ],
    [
      "a fourth callback from the address",
      { accepted: [fromCaller, fromCaller, fromCaller] },
      callback(),
      /address already had 3 accepted .*PAGE_EVENT_DAILY_LIMIT_PER_IP/,
    ],
  ]) {
    const e = endpoint({ env: on, ...options });
    const response = await e.send(body);
    // Answered like an accepted one.
    assert.equal(response.status, 200, name);
    assert.deepEqual({ ...response.body }, { ok: true }, name);
    // No event, no contact row, no delivery: a flood of these cannot fill the database.
    assert.ok(e.wroteNothing(), name);
    assert.equal(e.queued.length, 0, name);
    // Refused by the cheap checks, before any transaction or lock.
    assert.equal(e.transactions(), 0, name);
    assert.equal(e.lockKeys.length, 0, name);
    // One line that says why and nothing about the caller.
    assert.equal(e.warnings.length, 1, name);
    assert.match(e.warnings[0][0], /^\[page-events\] refused callback\.requested: /, name);
    assert.match(e.warnings[0][0], reason, name);
    const line = JSON.stringify(e.warnings);
    for (const personal of ["parent@example.com", "555", "Pat", VISIT, CALLER_IP]) {
      assert.equal(line.includes(personal), false, `${name}: ${personal}`);
    }
  }
});

test("the rules per visit and per address count only accepted callbacks of the last 24 hours", async () => {
  const fromCaller = (more = {}) => ({ ipAddress: CALLER_IP, ...more });
  for (const [name, options] of [
    ["two from the address", { accepted: [fromCaller(), fromCaller()] }],
    [
      "three from the address, one of them over a day old",
      { accepted: [fromCaller(), fromCaller(), fromCaller({ minutesAgo: DAY_MINUTES + 5 })] },
    ],
    [
      "the visit's last callback over a day old",
      { accepted: [{ vaAttrib: VISIT, minutesAgo: DAY_MINUTES + 5 }] },
    ],
    [
      "three from the address with the limit raised",
      {
        accepted: [fromCaller(), fromCaller(), fromCaller()],
        env: { ...on, PAGE_EVENT_DAILY_LIMIT_PER_IP: "5" },
      },
    ],
  ]) {
    const e = endpoint({ env: on, ...options });
    await e.send(callback());
    assert.deepEqual(statuses(e), delivered, name);
    assert.equal(e.warnings.length, 0, name);
  }

  // Requests with no address share one allowance.
  const unknown = { ipAddress: null };
  const noAddress = endpoint({ env: on, accepted: [unknown, unknown, unknown] });
  await noAddress.send(callback(), { ip: null });
  assert.ok(noAddress.wroteNothing());
  assert.match(noAddress.warnings[0][0], /address already had 3/);
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
    await e.send(callback(), { ip: sent });
    assert.equal(e.added().contacts[0].ipAddress, countedAs, sent);
  }

  // Three accepted from one network: a fourth address of that network is refused, while a
  // neighbouring network is not.
  const network = { ipAddress: "2001:db8:1:2::/64" };
  const sameNetwork = endpoint({ env: on, accepted: [network, network, network] });
  await sameNetwork.send(callback(), { ip: "2001:db8:1:2:9999::1" });
  assert.ok(sameNetwork.wroteNothing());
  const neighbour = endpoint({ env: on, accepted: [network, network, network] });
  await neighbour.send(callback(), { ip: "2001:db8:1:3:9999::1" });
  assert.deepEqual(statuses(neighbour), delivered);
});

test("past the daily alert threshold an error is logged and the event is still delivered", async () => {
  // 25 callbacks already accepted in the last 24 hours, each from its own visit and address.
  const busy = endpoint({ env: on, accepted: Array.from({ length: 25 }, () => ({})) });
  assert.equal((await busy.send(callback())).status, 200);
  // Other visitors' traffic never refuses an event: a shared limit would let a few forged
  // requests a day stop every real callback.
  assert.deepEqual(statuses(busy), delivered);
  assert.equal(busy.queued.length, 1);
  // The line monitoring looks for, naming the switch that stops a flood.
  assert.equal(busy.errors.length, 1);
  assert.match(busy.errors[0][0], /^\[page-events\] 26 page events in 24 hours/);
  assert.match(busy.errors[0][0], /PAGE_EVENT_DAILY_ALERT_THRESHOLD \(25\)/);
  assert.match(busy.errors[0][0], /PAGE_DELIVERY_PLATFORMS/);
  assert.equal(JSON.stringify(busy.errors).includes("parent@example.com"), false);

  const quiet = endpoint({ env: on, accepted: Array.from({ length: 24 }, () => ({})) });
  await quiet.send(callback());
  assert.deepEqual(statuses(quiet), delivered);
  assert.equal(quiet.errors.length, 0);

  // The setting moves the threshold.
  const lowered = endpoint({
    env: { ...on, PAGE_EVENT_DAILY_ALERT_THRESHOLD: "2" },
    accepted: [{}, {}],
  });
  await lowered.send(callback());
  assert.deepEqual(statuses(lowered), delivered);
  assert.match(lowered.errors[0][0], /^\[page-events\] 3 page events/);
});

test("of several callbacks sent at once for one visit, exactly one is accepted", async () => {
  // Eight requests at the same moment, each from another address, all for one visit. None has
  // been committed when the others run their first checks.
  const e = endpoint({ env: on });
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, n) => e.send(callback(), { ip: `198.51.100.${n + 1}` })),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    Array(8).fill(200),
  );
  assert.equal(e.added().events.length, 1);
  assert.equal(e.added().contacts.length, 1);
  assert.equal(e.queued.length, 1);
  // The other seven were refused under the visit's lock, and wrote nothing.
  assert.equal(e.warnings.length, 7);
  for (const [line] of e.warnings) assert.match(line, /visit already reported one/);
});

test("of several callbacks sent at once from one address, only its daily limit is accepted", async () => {
  // Eight requests at the same moment from one address, each for another visit.
  const visits = Array.from({ length: 8 }, (_, n) => visit(n + 1));
  const e = endpoint({ env: on, visits });
  await Promise.all(visits.map((row) => e.send(callback({ attribTok: row.token }))));
  assert.equal(e.added().events.length, 3);
  assert.equal(e.added().contacts.length, 3);
  assert.equal(e.warnings.length, 5);
  for (const [line] of e.warnings) assert.match(line, /address already had 3 accepted/);
});

test("a request held up inside its transaction does not hold up another visitor", async () => {
  // Visit 1 is stuck in its transaction, holding its locks, until it is let go.
  let letGo;
  const stuck = new Promise((resolve) => (letGo = resolve));
  const e = endpoint({
    env: on,
    visits: [visit(1, { utmSource: "stuck" }), visit(2), visit(3)],
    duringTransaction: (snapshot) => (snapshot.utmSource === "stuck" ? stuck : undefined),
  });
  const finished = [];
  const send = (n, ip) =>
    e.send(callback({ attribTok: visitToken(n) }), { ip }).then(() => finished.push(n));

  const first = send(1, "198.51.100.1");
  // Another visit from another address: no lock in common, so it goes straight through.
  await send(2, "198.51.100.2");
  assert.deepEqual(finished, [2]);
  // Another visit from the stuck request's address has to wait for it, and only it.
  const sameAddress = send(3, "198.51.100.1");
  await tick();
  await tick();
  assert.deepEqual(finished, [2]);

  letGo();
  await Promise.all([first, sameAddress]);
  assert.deepEqual(finished.sort(), [1, 2, 3]);
  assert.equal(e.added().events.length, 3);
});
