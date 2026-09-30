import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Execute the real route with in-memory database, QStash verification and outbound
// boundaries. No dev server, database, credentials or external network is involved.
function loadRoute(relativePath, dependencies) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  const context = createContext({
    exports,
    process: {
      env: {
        QSTASH_CURRENT_SIGNING_KEY: "synthetic",
        QSTASH_NEXT_SIGNING_KEY: "synthetic",
        ACUITY_API_KEY: "synthetic",
        ACUITY_TRIAL_APPOINTMENT_TYPE_IDS: "456",
      },
    },
    Date,
    URL,
    URLSearchParams,
    console,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected import: ${name}`);
      return dependencies[name];
    },
  });
  runInContext(outputText, context);
  return exports;
}

function worker(result, options = {}) {
  const updates = [];
  const sent = [];
  const validations = [];
  const probes = [];
  const dependencies = {
    "next/server": {
      NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
    },
    "@upstash/qstash": {
      Receiver: class {
        async verify() {
          if (options.signatureThrows) throw new Error("Invalid signature");
          return options.signed !== false;
        }
      },
    },
    "@/lib/prisma": {
      prisma: {
        canonicalEvent: {
          findUnique: async () => ({
            id: "ce1",
            name: "TRIAL_BOOKED",
            eventTime: new Date(),
            appointmentId: "123",
            eventId: "123",
            attributionTok: "attr",
            deliveries: options.deliveries ?? [{ id: "d1", platform: "OPENAI", status: "PENDING" }],
          }),
        },
        appointment: {
          findUnique: async () => ({
            email: "test@example.com",
            scheduledBy: options.staff ? "staff" : null,
          }),
        },
        attribution: { findUnique: async () => ({ lastUrl: "https://virtu.academy" }) },
        delivery: {
          findFirst: async (query) => {
            probes.push(query);
            if (options.databaseFails) throw new Error("private database error");
            return null;
          },
          update: async (update) => {
            updates.push(update);
          },
        },
      },
    },
    "@/lib/outbound/openai.mjs": {
      validateOpenAIConversion: async (id) => {
        validations.push(id);
        return result;
      },
      sendOpenAIConversion: async (args) => {
        sent.push(args);
        return result;
      },
    },
  };
  for (const [path, method] of [
    ["meta", "sendMetaCapi"],
    ["googleAds", "sendGoogleAdsClickConversion"],
    ["tiktok", "sendTikTokEvent"],
    ["hubspot", "sendHubSpotEvent"],
  ]) {
    dependencies[`@/lib/outbound/${path}`] = {
      [method]: () => {
        throw new Error("Existing platform unexpectedly resent");
      },
    };
  }
  const { POST } = loadRoute("../src/app/api/qstash/deliver/route.ts", dependencies);
  return {
    updates,
    sent,
    probes,
    validations,
    invoke: () =>
      POST({
        text: async () =>
          options.raw ?? JSON.stringify(options.message ?? { canonicalEventId: "ce1" }),
        headers: new Headers({ "upstash-signature": "synthetic" }),
      }),
  };
}

test("signed worker records OpenAI success and passes stable event input", async () => {
  const w = worker({
    skipped: false,
    ok: true,
    validated: false,
    retryable: false,
    status: 200,
    body: "accepted",
    requestBody: "safe summary",
  });
  assert.equal((await w.invoke()).status, 200);
  assert.equal(w.updates[0].data.status, "SUCCESS");
  assert.equal(w.sent[0].eventId, "123");
  assert.equal(w.sent[0].eventName, "TRIAL_BOOKED");
});

test("validation and disabled states never masquerade as delivered conversions", async () => {
  for (const r of [
    { skipped: true, reason: "disabled" },
    {
      skipped: false,
      ok: true,
      validated: true,
      retryable: false,
      status: 200,
      body: "validation_only",
    },
  ]) {
    const w = worker(r);
    await w.invoke();
    assert.equal(w.updates[0].data.status, "SKIPPED");
  }
});

test("transient OpenAI failure returns 503 so QStash retries, without resending completed platforms", async () => {
  const w = worker(
    {
      skipped: false,
      ok: false,
      validated: false,
      retryable: true,
      status: 429,
      body: "rate limited",
    },
    {
      deliveries: [
        { id: "meta", platform: "META", status: "SUCCESS" },
        { id: "d1", platform: "OPENAI", status: "PENDING" },
      ],
    },
  );
  assert.equal((await w.invoke()).status, 503);
  assert.equal(w.updates.length, 1);
  assert.equal(w.updates[0].data.status, "FAILED");
});

test("permanent OpenAI errors are recorded without an automatic retry loop", async () => {
  const w = worker({
    skipped: false,
    ok: false,
    validated: false,
    retryable: false,
    status: 401,
    body: "unauthorized",
  });
  assert.equal((await w.invoke()).status, 200);
  assert.equal(w.updates[0].data.status, "FAILED");
});

test("staff bookings, completed deliveries, and invalid QStash signatures never call OpenAI", async () => {
  for (const options of [
    { staff: true },
    { signed: false },
    { deliveries: [{ id: "d1", platform: "OPENAI", status: "SUCCESS" }] },
  ]) {
    const w = worker(null, options);
    const response = await w.invoke();
    assert.equal(w.sent.length, 0);
    if (options.signed === false) assert.equal(response.status, 401);
  }
});

test("Acuity changed queues first bookings, skips historical edits, and keeps staff excluded", async () => {
  for (const [staff, prior] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    const deliveries = [];
    const queued = [];
    const appt = { id: 123, appointmentTypeID: 456, amountPaid: 10 };
    const dependencies = {
      "next/server": {
        NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
      },
      "@/lib/auth": { timingSafeEqual: () => true },
      "@/lib/crypto": { sha256Base64: () => "sig", sha256Hex: () => "hash" },
      "@/lib/acuity": {
        fetchAppointmentById: async () => appt,
        extractIntakeValue: () => null,
        appointmentSnapshot: () => ({ scheduledBy: staff ? "staff" : null }),
      },
      "@/lib/qstash": { enqueueDelivery: async (id) => queued.push(id) },
      "@/lib/prisma": {
        prisma: {
          inboundWebhook: { create: async () => {} },
          appointment: { upsert: async () => {} },
          canonicalEvent: {
            create: async () => ({ id: "ce1" }),
            findFirst: async () => (prior ? { id: "previous" } : null),
          },
          delivery: { createMany: async ({ data }) => deliveries.push(...data) },
        },
      },
    };
    const { POST } = loadRoute("../src/app/api/webhooks/acuity/route.ts", dependencies);
    await POST({
      headers: new Headers({ "x-acuity-signature": "sig" }),
      text: async () => "action=changed&id=123",
    });
    assert.deepEqual(
      deliveries.map((d) => d.platform),
      staff ? [] : ["META", "HUBSPOT", "GOOGLE_ADS", "TIKTOK", "OPENAI"],
    );
    assert.equal(queued.length, staff ? 0 : 1);
    if (!staff)
      assert.equal(
        deliveries.find((d) => d.platform === "OPENAI").status,
        prior ? "SKIPPED" : "PENDING",
      );
  }
});

const validationMessage = {
  kind: "openai_validation",
  validationId: "12345678-1234-4123-8123-123456789abc",
};
const validationResult = {
  skipped: false,
  ok: true,
  validated: true,
  retryable: false,
  status: 200,
};

test("signed synthetic job probes the database and validates OpenAI without writing records or invoking normal delivery", async () => {
  const w = worker(validationResult, { message: validationMessage });
  const response = await w.invoke();
  assert.equal(response.status, 200);
  assert.equal(response.body.validationOnly, true);
  assert.equal(response.body.openaiHttpStatus, 200);
  assert.equal(response.body.database, "ok");
  assert.equal(w.probes.length, 1);
  assert.equal(w.probes[0].where.platform, "OPENAI");
  assert.deepEqual(w.validations, [validationMessage.validationId]);
  assert.equal(w.updates.length, 0);
  assert.equal(w.sent.length, 0);
});

test("synthetic jobs require a valid signature before any database or API access", async () => {
  for (const signing of [{ signed: false }, { signatureThrows: true }]) {
    const w = worker(validationResult, { message: validationMessage, ...signing });
    assert.equal((await w.invoke()).status, 401);
    assert.equal(w.probes.length, 0);
    assert.equal(w.validations.length, 0);
    assert.equal(w.sent.length, 0);
  }
});

test("synthetic jobs reject customer data, booking IDs, mode overrides, and malformed messages", async () => {
  for (const message of [
    { ...validationMessage, validationId: "a-customer@example.com" },
    { ...validationMessage, canonicalEventId: "ce1" },
    { ...validationMessage, validate_only: false },
    { ...validationMessage, email: "a-customer@example.com" },
    { kind: "unknown", canonicalEventId: "ce1" },
    null,
    [],
    {},
  ]) {
    const w = worker(validationResult, { raw: JSON.stringify(message) });
    assert.equal((await w.invoke()).status, 400);
    assert.equal(w.probes.length, 0);
    assert.equal(w.validations.length, 0);
    assert.equal(w.sent.length, 0);
  }
  assert.equal((await worker(validationResult, { raw: "invalid json" }).invoke()).status, 400);
});

test("database probe failure stops validation and does not expose the database error", async () => {
  const w = worker(validationResult, { message: validationMessage, databaseFails: true });
  const response = await w.invoke();
  assert.equal(response.status, 503);
  assert.equal(response.body.stage, "database");
  assert.equal(w.validations.length, 0);
  assert.equal(JSON.stringify(response).includes("private"), false);
});

test("synthetic job acknowledges only accepted validation and surfaces configuration/API failures", async () => {
  for (const [result, status] of [
    [{ skipped: true, reason: "Missing configuration" }, 422],
    [{ ...validationResult, ok: false, status: 401 }, 502],
    [{ ...validationResult, ok: false, retryable: true, status: 429 }, 503],
    [{ ...validationResult, validated: false }, 502],
  ]) {
    const w = worker(result, { message: validationMessage });
    const response = await w.invoke();
    assert.equal(response.status, status);
    assert.equal(response.body.ok, false);
    assert.equal(w.updates.length, 0);
    assert.equal(w.sent.length, 0);
  }
});
