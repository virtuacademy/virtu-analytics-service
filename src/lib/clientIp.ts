/**
 * The caller's IP address as the hosting proxy reports it: the first X-Forwarded-For entry,
 * else X-Real-IP. It is only as trustworthy as the proxy in front of this service.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip");
}
