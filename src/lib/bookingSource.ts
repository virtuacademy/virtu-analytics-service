// Which booking system produced an appointment. Acuity appointment IDs are numeric;
// Opus bookings are recorded under `opus_<lessonId>` (see docs/opus-trial-webhook.md).
// Pure module: the dashboard imports it on the client.

export type BookingSource = "acuity" | "opus";

export const OPUS_EVENT_ID_PREFIX = "opus_";

export function bookingSourceFor(appointmentId: string | null | undefined): BookingSource {
  return appointmentId?.startsWith(OPUS_EVENT_ID_PREFIX) ? "opus" : "acuity";
}

// Opus bookings are only ever delivered to these platforms.
export const OPUS_DELIVERY_PLATFORMS = ["GOOGLE_ADS", "HUBSPOT"] as const;
export type OpusDeliveryPlatform = (typeof OPUS_DELIVERY_PLATFORMS)[number];

/** Parse `OPUS_DELIVERY_PLATFORMS` ("GOOGLE_ADS,HUBSPOT"); unknown names are ignored. */
export function enabledOpusDeliveryPlatforms(
  value: string | null | undefined,
): Set<OpusDeliveryPlatform> {
  const enabled = new Set<OpusDeliveryPlatform>();
  for (const part of (value ?? "").split(",")) {
    const name = part.trim().toUpperCase();
    const platform = OPUS_DELIVERY_PLATFORMS.find((candidate) => candidate === name);
    if (platform) enabled.add(platform);
  }
  return enabled;
}
