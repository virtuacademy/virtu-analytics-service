import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const COOKIE_NAME = "va_auth";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do comparison to prevent timing attacks on length
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: NextRequest) {
  if (!AUTH_PASSWORD) {
    // No password configured = bypass auth (for local dev without .env)
    const res = NextResponse.json({ success: true });
    return res;
  }

  try {
    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== "string") {
      return NextResponse.json({ error: "Password required" }, { status: 400 });
    }

    if (!timingSafeEqual(password, AUTH_PASSWORD)) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    // Generate session token
    const sessionToken = crypto.randomUUID();
    const isDev = process.env.NODE_ENV !== "production";
    // Only set domain for production on the main domain, not preview deployments
    const isVercelPreview = process.env.VERCEL_ENV === "preview";
    const cookieDomain = process.env.COOKIE_DOMAIN ?? ".virtu.academy";

    const res = NextResponse.json({ success: true });
    res.cookies.set({
      name: COOKIE_NAME,
      value: sessionToken,
      httpOnly: true,
      secure: !isDev,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      // Don't set domain for dev or Vercel preview deployments
      domain: isDev || isVercelPreview ? undefined : cookieDomain,
    });

    return res;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE() {
  const isDev = process.env.NODE_ENV !== "production";
  const isVercelPreview = process.env.VERCEL_ENV === "preview";
  const cookieDomain = process.env.COOKIE_DOMAIN ?? ".virtu.academy";

  const res = NextResponse.json({ success: true });
  res.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: !isDev,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    domain: isDev || isVercelPreview ? undefined : cookieDomain,
  });

  return res;
}
