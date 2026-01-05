export async function sendGoogleAdsClickConversion(_args: {
  eventId: string;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  email?: string | null;
  phoneDigits?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  void _args;
  return { skipped: true, reason: "GOOGLE_ADS not implemented in v1 starter" };
}
