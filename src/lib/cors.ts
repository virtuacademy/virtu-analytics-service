import { NextResponse } from "next/server";

export function withCors(res: NextResponse, origin: string | null) {
  const allowed = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin = origin && allowed.includes(origin) ? origin : (allowed[0] ?? "");
  if (allowOrigin) res.headers.set("Access-Control-Allow-Origin", allowOrigin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  return res;
}
