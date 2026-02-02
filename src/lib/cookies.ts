import type { NextResponse } from "next/server";

export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? ".virtu.academy";

export function setCookie(res: NextResponse, name: string, value: string, maxAgeSeconds: number) {
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
    domain: isDev ? undefined : COOKIE_DOMAIN,
  });
}

export function setReadableCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAgeSeconds: number,
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
    domain: isDev ? undefined : COOKIE_DOMAIN,
  });
}
