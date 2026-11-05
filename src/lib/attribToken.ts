// Ingest IDs (visitor, session and attribution tokens) are always randomId(), a UUID.
// Anything else arriving from a browser is not ours, and could collide with server-side
// tokens such as Opus bookings' `opus_<lessonId>`.
export const INGEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value when it is UUID-shaped, else null. */
export function ingestIdOrNull(value: unknown): string | null {
  return typeof value === "string" && INGEST_ID_PATTERN.test(value) ? value : null;
}
