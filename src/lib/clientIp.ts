/**
 * The caller's IP address as the hosting proxy reports it: the first X-Forwarded-For entry,
 * else X-Real-IP. It is only as trustworthy as the proxy in front of this service.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip");
}

/**
 * What a limit per address counts by: an IPv4 address itself, and an IPv6 address's /64
 * network. One IPv6 connection usually holds a whole /64, so counting single addresses would
 * let it rotate through them. Null when there is no address.
 */
export function addressLimitKey(ip: string | null | undefined): string | null {
  // Lower case, without a zone ("fe80::1%eth0").
  const address = ip?.trim().toLowerCase().split("%")[0] ?? "";
  if (!address) return null;
  if (!address.includes(":")) return address.slice(0, 64);

  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7") is still that one IPv4 address.
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];

  // Write out the groups "::" stands for, then keep the first four.
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array(Math.max(8 - head.length - tail.length, 0)).fill("0"), ...tail];
  const wellFormed =
    halves.length <= 2 &&
    groups.length === 8 &&
    groups.every((group) => /^[0-9a-f]{1,4}$/.test(group));
  // Anything else is counted as it was sent.
  if (!wellFormed) return address.slice(0, 64);
  const network = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ""));
  return `${network.join(":")}::/64`;
}
