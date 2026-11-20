import { Client } from "@upstash/qstash";

export const qstash = new Client({
  token: process.env.QSTASH_TOKEN || "",
});

export async function enqueueDelivery(canonicalEventId: string) {
  if (!process.env.QSTASH_TOKEN) {
    return;
  }

  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    console.error("Missing PUBLIC_BASE_URL; cannot enqueue QStash delivery.");
    return;
  }

  const url = `${baseUrl}/api/qstash/deliver`;
  await qstash.publishJSON({
    url,
    body: { canonicalEventId },
  });
}

/**
 * Asks the worker to try one platform's delivery of an event again, no earlier than
 * `notBefore`. The message names the platform, so the worker leaves the event's other
 * deliveries alone. Throws when it cannot be queued, so the caller never waits for a message
 * that was not sent.
 */
export async function enqueuePlatformRetry(
  canonicalEventId: string,
  platform: "GOOGLE_ADS",
  notBefore: Date,
) {
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (!process.env.QSTASH_TOKEN || !baseUrl) {
    throw new Error("QStash is not configured (QSTASH_TOKEN, PUBLIC_BASE_URL)");
  }

  await qstash.publishJSON({
    url: `${baseUrl}/api/qstash/deliver`,
    body: { canonicalEventId, platform },
    notBefore: Math.ceil(notBefore.getTime() / 1000),
  });
}
