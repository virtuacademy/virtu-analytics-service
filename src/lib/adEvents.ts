// Shared rules for events that are not bookings: an account created in Opus, a callback
// requested on the trial page.

/**
 * The conversion value of an event that carries none of its own, from EVENT_VALUES:
 * "source:EVENT=amount" pairs in USD, for example
 * "opus:ACCOUNT_CREATED=15,page:CALLBACK_REQUESTED=15". Null when the event has no entry, and
 * then no value is sent to any platform.
 */
export function configuredEventValue(
  source: string,
  eventName: string,
  setting: string | undefined = process.env.EVENT_VALUES,
): number | null {
  for (const pair of (setting ?? "").split(",")) {
    const [key, amount] = pair.split("=").map((part) => part.trim());
    if (key !== `${source}:${eventName}` || !amount) continue;
    const value = Number(amount);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}

type ClickIds = {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  dclid?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  ttclid?: string | null;
  msclkid?: string | null;
};

/**
 * True when an event has neither an ad click ID nor an email or phone number. No platform
 * could match such an event to a person or a click, so it is recorded and never delivered.
 */
export function hasNothingToMatch(
  click: ClickIds,
  contact: { email?: string | null; phone?: string | null },
): boolean {
  const { gclid, gbraid, wbraid, dclid, fbclid, fbc, ttclid, msclkid } = click;
  const hasClickId = [gclid, gbraid, wbraid, dclid, fbclid, fbc, ttclid, msclkid].some(Boolean);
  return !hasClickId && !contact.email && !contact.phone;
}
