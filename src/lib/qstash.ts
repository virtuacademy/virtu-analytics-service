import { Client } from "@upstash/qstash";

export const qstash = new Client({
  token: process.env.QSTASH_TOKEN || "",
});

export async function enqueueDelivery(canonicalEventId: string) {
  if (!process.env.QSTASH_TOKEN) {
    return;
  }

  const url = `${process.env.PUBLIC_BASE_URL}/api/qstash/deliver`;
  await qstash.publishJSON({
    url,
    body: { canonicalEventId },
  });
}
