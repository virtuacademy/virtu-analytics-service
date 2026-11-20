// Google rejects an upload for a click that is less than six hours old
// (ConversionUploadError.TOO_RECENT_EVENT: "Retry after 6 hours have passed"). A signup or a
// booking often follows its ad click within minutes, so a Google Ads delivery waits until the
// click is old enough. The extra quarter of an hour is margin.

const DEFAULT_HOLD_MINUTES = 375;

/** GOOGLE_ADS_HOLD_MINUTES in milliseconds. Unset or unreadable means the default; 0 is off. */
export function googleAdsHoldMs(value = process.env.GOOGLE_ADS_HOLD_MINUTES): number {
  const trimmed = value?.trim();
  const minutes = trimmed ? Number(trimmed) : Number.NaN;
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_HOLD_MINUTES) * 60_000;
}

/**
 * When a Google Ads delivery may first be attempted, or null when it may go now.
 *
 * `lastTouch` is the last moment the visit was seen, so its click is no later than that. A
 * click also cannot be later than the event it led to, which bounds a visit that was seen
 * again afterwards, and stands in when no visit is known.
 */
export function googleAdsNotBefore(
  lastTouch: Date | null | undefined,
  eventTime: Date,
  now: Date = new Date(),
): Date | null {
  const holdMs = googleAdsHoldMs();
  if (holdMs === 0) return null;
  const clickNoLaterThan =
    lastTouch && lastTouch.getTime() < eventTime.getTime() ? lastTouch : eventTime;
  const due = new Date(clickNoLaterThan.getTime() + holdMs);
  return due.getTime() > now.getTime() ? due : null;
}

/** When to upload again after Google answered that the click is still too recent. */
export function googleAdsRetryAfterTooRecent(now: Date = new Date()): Date {
  return new Date(now.getTime() + (googleAdsHoldMs() || DEFAULT_HOLD_MINUTES * 60_000));
}
