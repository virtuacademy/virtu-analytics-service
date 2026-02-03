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
