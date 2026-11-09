import type { NextResponse } from "next/server";

export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? ".virtu.academy";

// Each site reaches this service through its own subdomain (attrib.virtu.academy,
// attrib.fortelessons.com). A request gets its cookies on that site's domain, so they are
// first-party there and set by a server, which Safari keeps far longer than cookies written by
// page scripts.
const SITE_COOKIE_DOMAINS = [COOKIE_DOMAIN, ".fortelessons.com"];

export function cookieDomainFor(host: string | null | undefined): string {
  const hostname = (host ?? "").split(":")[0].trim().toLowerCase();
  return (
    SITE_COOKIE_DOMAINS.find(
      (domain) => hostname === domain.slice(1) || hostname.endsWith(domain),
    ) ?? COOKIE_DOMAIN
  );
}

export function setCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
  domain: string = COOKIE_DOMAIN,
) {
  // DEV ONLY: allow localhost testing (remove/adjust before prod deploy).
  const isDev = process.env.NODE_ENV !== "production";
  res.cookies.set({
    name,
    value,
    httpOnly: true,
    secure: !isDev,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
    domain: isDev ? undefined : domain,
  });
}

export function setReadableCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
  domain: string = COOKIE_DOMAIN,
) {
  // DEV ONLY: allow localhost testing (remove/adjust before prod deploy).
  const isDev = process.env.NODE_ENV !== "production";
  res.cookies.set({
    name,
    value,
    httpOnly: false,
    secure: !isDev,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
    domain: isDev ? undefined : domain,
  });
}
