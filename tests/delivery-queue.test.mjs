import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real queue helper (src/lib/qstash.ts) against a stubbed QStash client.

function queue(env = { QSTASH_TOKEN: "synthetic", PUBLIC_BASE_URL: "https://attrib.example" }) {
  const published = [];
  const { enqueueDelivery, enqueuePlatformRetry } = loadTsModule(
    new URL("../src/lib/qstash.ts", import.meta.url),
    {
      "@upstash/qstash": {
        Client: class {
          async publishJSON(request) {
            published.push(request);
          }
        },
      },
    },
    { process: { env }, console: { error: () => {} } },
  );
  return { enqueueDelivery, enqueuePlatformRetry, published };
}

test("a platform retry is one message for a later time that names the platform", async () => {
  const q = queue();
  const notBefore = new Date("2026-11-21T05:15:00.400Z");
  await q.enqueuePlatformRetry("ce_1", "GOOGLE_ADS", notBefore);

  assert.equal(q.published.length, 1);
  const [message] = q.published;
  assert.equal(message.url, "https://attrib.example/api/qstash/deliver");
  // The platform is what keeps the worker off the event's other deliveries.
  assert.deepEqual({ ...message.body }, { canonicalEventId: "ce_1", platform: "GOOGLE_ADS" });
  // Whole seconds, never earlier than asked.
  assert.equal(message.notBefore, Math.ceil(notBefore.getTime() / 1000));

  // An ordinary delivery message is unchanged: the event only, sent at once.
  await q.enqueueDelivery("ce_2");
  assert.deepEqual({ ...q.published[1].body }, { canonicalEventId: "ce_2" });
  assert.equal(q.published[1].notBefore, undefined);
});

test("a platform retry that cannot be queued throws, so nothing waits for a message never sent", async () => {
  for (const env of [
    {},
    { QSTASH_TOKEN: "synthetic" },
    { PUBLIC_BASE_URL: "https://attrib.example" },
  ]) {
    const q = queue(env);
    await assert.rejects(
      q.enqueuePlatformRetry("ce_1", "GOOGLE_ADS", new Date()),
      /QStash is not configured/,
    );
    assert.equal(q.published.length, 0);
  }
});
