import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./support/load-ts-module.mjs";

// The real queue helper (src/lib/qstash.ts) against a stubbed QStash client and database.

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60 * 1000);

function queue(pending, options = {}) {
  const published = [];
  const released = [];
  const { queueDeliveries } = loadTsModule(
    new URL("../src/lib/qstash.ts", import.meta.url),
    {
      "@upstash/qstash": {
        Client: class {
          async publishJSON(request) {
            if (options.laterMessagesFail && request.notBefore) throw new Error("queue refused");
            published.push(request);
          }
        },
      },
      "@/lib/prisma": {
        prisma: {
          delivery: {
            findMany: async () => pending,
            updateMany: async (args) => released.push(args),
          },
        },
      },
    },
    {
      process: { env: { QSTASH_TOKEN: "synthetic", PUBLIC_BASE_URL: "https://attrib.example" } },
    },
  );
  return { queueDeliveries, published, released };
}

test("due deliveries are queued now and a held one for its own time", async () => {
  const heldUntil = inMinutes(370);
  const q = queue([
    { id: "hubspot", notBefore: null },
    { id: "google", notBefore: heldUntil },
  ]);
  await q.queueDeliveries("ce_1");

  assert.equal(q.published.length, 2);
  const later = q.published.find((message) => message.notBefore);
  const now = q.published.find((message) => !message.notBefore);
  assert.equal(later.notBefore, Math.ceil(heldUntil.getTime() / 1000));
  assert.equal(later.url, "https://attrib.example/api/qstash/deliver");
  assert.deepEqual({ ...later.body }, { canonicalEventId: "ce_1" });
  assert.deepEqual({ ...now.body }, { canonicalEventId: "ce_1" });
  assert.equal(q.released.length, 0);

  // Nothing due yet: no message that would only find a held delivery.
  const onlyHeld = queue([{ id: "google", notBefore: heldUntil }]);
  await onlyHeld.queueDeliveries("ce_1");
  assert.deepEqual(
    onlyHeld.published.map((message) => Boolean(message.notBefore)),
    [true],
  );
});

test("a held delivery that cannot be scheduled is released and sent now", async () => {
  const q = queue([{ id: "google", notBefore: inMinutes(370) }], { laterMessagesFail: true });
  await q.queueDeliveries("ce_1");

  // The hold is lifted in the database, then the worker is asked to deliver at once.
  assert.deepEqual(JSON.parse(JSON.stringify(q.released)), [
    { where: { id: { in: ["google"] } }, data: { notBefore: null } },
  ]);
  assert.equal(q.published.length, 1);
  assert.equal(q.published[0].notBefore, undefined);
});
