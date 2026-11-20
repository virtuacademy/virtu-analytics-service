import { NextResponse } from "next/server";

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether a request's Origin header names a site listed in ALLOWED_ORIGINS. */
export function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && allowedOrigins().includes(origin);
}

export function withCors(res: NextResponse, origin: string | null) {
  const allowed = allowedOrigins();

  const allowOrigin = origin && allowed.includes(origin) ? origin : (allowed[0] ?? "");
  if (allowOrigin) res.headers.set("Access-Control-Allow-Origin", allowOrigin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  return res;
}
