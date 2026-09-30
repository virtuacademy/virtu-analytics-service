import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sendOpenAIConversion } from "../src/lib/outbound/openai.mjs";

const now = Date.now();
const secret = "synthetic-capi-key";
const env = {
  OPENAI_CAPI_ENABLED: "true",
  OPENAI_CAPI_API_KEY: secret,
  OPENAI_CAPI_PIXEL_ID: "pixel_synthetic",
};
const args = {
  eventId: "123",
  eventName: "TRIAL_BOOKED",
  eventTime: new Date(now),
  eventSourceUrl: "https://virtu.academy/schedule?token=private#secret",
  email: " Test.User+Lessons@Example.com ",
  phone: "+1 (415) 555-2671",
  ip: "203.0.113.1",
  userAgent: "Synthetic-Agent",
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
function run(event = args, overrides = {}, response = new Response(null, { status: 200 })) {
  const calls = [];
  const result = sendOpenAIConversion(event, {
    now,
    env: { ...env, ...overrides },
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init, payload: JSON.parse(init.body) });
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { result, calls };
}

test("documented CAPI endpoint, auth, event shape, hashing, and validation default", async () => {
  const { result, calls } = run();
  const r = await result;
  assert.equal(r.ok, true);
  assert.equal(r.validated, true);
  const { url, init, payload } = calls[0];
  assert.equal(url.origin + url.pathname, "https://bzr.openai.com/v1/events");
  assert.equal(url.searchParams.get("pid"), "pixel_synthetic");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(payload.validate_only, true);
  assert.equal(payload.integration_source, "virtu_analytics_service");
  assert.deepEqual(payload.events, [
    {
      id: "acuity_booking_123",
      type: "appointment_scheduled",
      timestamp_ms: now,
      source_url: "https://virtu.academy/schedule",
      action_source: "web",
      opt_out: true,
      user: {
        emails_sha256: [hash("test.user+lessons@example.com")],
        phone_numbers_sha256: [hash("14155552671")],
        ip_address: "203.0.113.1",
        user_agent: "Synthetic-Agent",
      },
      data: { type: "customer_action" },
    },
  ]);
  for (const value of [
    secret,
    "Test.User",
    "14155552671",
    hash("test.user+lessons@example.com"),
    "203.0.113.1",
    "private",
  ]) {
    assert.ok(!JSON.stringify(r).includes(value));
  }
});

test("missing/disabled configuration and mock mode never send", async () => {
  for (const override of [
    { OPENAI_CAPI_ENABLED: undefined },
    { OPENAI_CAPI_ENABLED: "false" },
    { OPENAI_CAPI_API_KEY: "" },
    { OPENAI_CAPI_PIXEL_ID: "" },
    { OPENAI_CAPI_API_KEY: "bad\nkey" },
    { OPENAI_CAPI_VALIDATE_ONLY: "False" },
    { OUTBOUND_MODE: "mock" },
  ]) {
    const { result, calls } = run(args, override);
    assert.equal((await result).skipped, true);
    assert.equal(calls.length, 0);
  }
});

test("only configured bookings are delivered, never reschedules, updates, cancellations", async () => {
  for (const eventName of [
    "APPOINTMENT_BOOKED",
    "TRIAL_RESCHEDULED",
    "TRIAL_CANCELED",
    "APPOINTMENT_UPDATED",
    "UNKNOWN",
  ]) {
    const { result, calls } = run({ ...args, eventName });
    assert.equal((await result).skipped, true);
    assert.equal(calls.length, 0);
  }
  const { result, calls } = run(
    { ...args, eventName: "APPOINTMENT_BOOKED" },
    { OPENAI_CAPI_EVENTS: "TRIAL_BOOKED,APPOINTMENT_BOOKED" },
  );
  assert.equal((await result).ok, true);
  assert.equal(calls[0].payload.events[0].type, "appointment_scheduled");
  const invalid = run(args, { OPENAI_CAPI_EVENTS: "TRIAL_CANCELED" });
  assert.equal((await invalid.result).skipped, true);
  assert.equal(invalid.calls.length, 0);
});

test("stale, invalid and future events are not silently retimestamped", async () => {
  for (const eventTime of [
    new Date(now - 7 * 86400_000 - 1),
    new Date(now + 600_001),
    new Date("invalid"),
  ]) {
    const { result, calls } = run({ ...args, eventTime });
    assert.equal((await result).skipped, true);
    assert.equal(calls.length, 0);
  }
});

test("stable appointment ID survives retries and separate canonical observations", async () => {
  const first = run();
  const second = run({ ...args, eventTime: new Date(now - 1000) });
  await first.result;
  await second.result;
  assert.equal(first.calls[0].payload.events[0].id, second.calls[0].payload.events[0].id);
});

test("live mode must be explicit and never adds speculative revenue", async () => {
  const { result, calls } = run(
    { ...args, value: 100, currency: "USD" },
    { OPENAI_CAPI_VALIDATE_ONLY: "false" },
  );
  const r = await result;
  assert.equal(r.validated, false);
  assert.equal(calls[0].payload.validate_only, false);
  assert.deepEqual(calls[0].payload.events[0].data, { type: "customer_action" });
});

test("national phone needs explicit country code; phone-only matches supported", async () => {
  const missing = run({ ...args, email: null, phone: "4155552671" });
  assert.equal((await missing.result).skipped, true);
  assert.equal(missing.calls.length, 0);
  const configured = run(
    { ...args, email: null, phone: "4155552671" },
    { OPENAI_CAPI_DEFAULT_PHONE_COUNTRY_CODE: "1" },
  );
  await configured.result;
  assert.deepEqual(configured.calls[0].payload.events[0].user.phone_numbers_sha256, [
    hash("14155552671"),
  ]);
  const explicit = run(
    { ...args, email: null, phone: "+46 12345678" },
    { OPENAI_CAPI_DEFAULT_PHONE_COUNTRY_CODE: "1" },
  );
  await explicit.result;
  assert.deepEqual(explicit.calls[0].payload.events[0].user.phone_numbers_sha256, [
    hash("4612345678"),
  ]);
});

test("bad identifiers, missing event ID and invalid source URLs skip without network", async () => {
  for (const input of [
    { ...args, email: "bad", phone: "ext123" },
    { ...args, eventId: " " },
    { ...args, eventSourceUrl: "https://virtu.academy.example.com" },
    { ...args, eventSourceUrl: "not-a-url" },
  ]) {
    const { result, calls } = run(input);
    assert.equal((await result).skipped, true);
    assert.equal(calls.length, 0);
  }
});

test("HTTP errors are sanitized and only transient failures ask for retry", async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const { result } = run(args, {}, new Response(`secret ${secret} ${args.email}`, { status }));
    const r = await result;
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.equal(r.retryable, status === 429 || status >= 500);
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.ok(!JSON.stringify(r).includes(args.email));
  }
});

test("network/timeout/redirect failures omit raw exceptions and remain retryable", async () => {
  const { result } = run(args, {}, new Error(`request header Bearer ${secret}`));
  const r = await result;
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r).includes(secret));
});
