export async function sendTikTokEvent(_args: {
  eventId: string;
  ttclid?: string | null;
}) {
  const requestBody = JSON.stringify(_args);
  return { skipped: true, reason: "TIKTOK not implemented in v1 starter", requestBody };
}
