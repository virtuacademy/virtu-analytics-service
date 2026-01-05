export async function sendTikTokEvent(_args: {
  eventId: string;
  ttclid?: string | null;
}) {
  return { skipped: true, reason: "TIKTOK not implemented in v1 starter" };
}
