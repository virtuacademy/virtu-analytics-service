// Which system produced an event. Acuity appointment IDs are numeric. Opus events are recorded
// under `opus_…` (a booking is `opus_<lessonId>`, an account `opus_account_<userId>`; see
// docs/opus-trial-webhook.md) and events a page reports under `page_…` (docs/page-events.md).
// Pure module: the dashboard imports it on the client.

export type BookingSource = "acuity" | "opus" | "page";

export const OPUS_EVENT_ID_PREFIX = "opus_";
export const PAGE_EVENT_ID_PREFIX = "page_";

export function bookingSourceFor(eventId: string | null | undefined): BookingSource {
  if (eventId?.startsWith(OPUS_EVENT_ID_PREFIX)) return "opus";
  if (eventId?.startsWith(PAGE_EVENT_ID_PREFIX)) return "page";
  return "acuity";
}

// Opus bookings are only ever delivered to these platforms.
export const OPUS_DELIVERY_PLATFORMS = ["GOOGLE_ADS", "HUBSPOT", "META"] as const;
export type OpusDeliveryPlatform = (typeof OPUS_DELIVERY_PLATFORMS)[number];

// Events that are not bookings (an account created, a callback requested) go to the ad
// platforms only. The app and the callback form already write those contacts to HubSpot.
export const AD_EVENT_DELIVERY_PLATFORMS = ["GOOGLE_ADS", "META"] as const;

/**
 * The setting that lists the platforms a source's events are delivered to. Acuity has none:
 * its events go to every platform that is configured.
 */
export function deliveryPlatformsSetting(
  source: BookingSource,
): "OPUS_DELIVERY_PLATFORMS" | "PAGE_DELIVERY_PLATFORMS" | null {
  if (source === "opus") return "OPUS_DELIVERY_PLATFORMS";
  if (source === "page") return "PAGE_DELIVERY_PLATFORMS";
  return null;
}

/** Whether an event may be delivered to `platform` under its source's setting value. */
export function isDeliveryEnabled(platform: string, value: string | null | undefined): boolean {
  return [...enabledDeliveryPlatforms(value)].some((enabled) => enabled === platform);
}

/** Parse a platforms setting ("GOOGLE_ADS,HUBSPOT,META"); unknown names are ignored. */
export function enabledDeliveryPlatforms(
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
