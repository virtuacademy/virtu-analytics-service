import { NextRequest, NextResponse } from "next/server";
import { verifyAuthCookieValue } from "@/lib/auth";

const COOKIE_NAME = "va_auth";

// Routes that don't require authentication
const PUBLIC_PATHS = [
  "/login",
  "/api/", // All API routes handle their own auth
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth check for public paths
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // Skip auth if no password is configured (local dev without .env)
  const authPassword = process.env.AUTH_PASSWORD;
  if (!authPassword) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = request.cookies.get(COOKIE_NAME);
  const valid = authCookie?.value
    ? await verifyAuthCookieValue(authCookie.value, authPassword)
    : null;
  if (!valid) {
    const loginUrl = new URL("/login", request.url);
    const res = NextResponse.redirect(loginUrl);
    const isDev = process.env.NODE_ENV !== "production";
    const isVercelPreview = process.env.VERCEL_ENV === "preview";
    const cookieDomain = process.env.COOKIE_DOMAIN ?? ".virtu.academy";
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

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public files (images, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
