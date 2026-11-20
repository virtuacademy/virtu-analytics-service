import { Client } from "@upstash/qstash";
import { prisma } from "@/lib/prisma";

export const qstash = new Client({
  token: process.env.QSTASH_TOKEN || "",
});

/** Sends one message to the delivery worker: now, or no earlier than `notBefore`. */
export async function enqueueDelivery(canonicalEventId: string, notBefore?: Date | null) {
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
    ...(notBefore ? { notBefore: Math.ceil(notBefore.getTime() / 1000) } : {}),
  });
}

/**
 * Queues an event's pending deliveries: one message now for those that are due, and one more
 * at each time a held delivery (`Delivery.notBefore`) becomes due.
 *
 * It fails open. A held delivery whose later message cannot be scheduled is released and goes
 * out with the message sent now: an upload Google may reject as too recent beats one that is
 * never attempted.
 */
export async function queueDeliveries(canonicalEventId: string) {
  const pending = await prisma.delivery.findMany({
    where: { canonicalEventId, status: "PENDING" },
    select: { id: true, notBefore: true },
  });

  const now = Date.now();
  let dueNow = false;
  const heldUntil = new Map<number, string[]>();
  for (const delivery of pending) {
    const time = delivery.notBefore?.getTime();
    if (time && time > now) heldUntil.set(time, [...(heldUntil.get(time) ?? []), delivery.id]);
    else dueNow = true;
  }

  for (const [time, deliveryIds] of heldUntil) {
    try {
      await enqueueDelivery(canonicalEventId, new Date(time));
    } catch {
      console.error("Could not schedule a held delivery; sending it now", { canonicalEventId });
      await prisma.delivery.updateMany({
        where: { id: { in: deliveryIds } },
        data: { notBefore: null },
      });
      dueNow = true;
    }
  }

  if (dueNow) await enqueueDelivery(canonicalEventId);
}
