import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomId } from "@/lib/crypto";
import { withCors } from "@/lib/cors";
import { setCookie, setReadableCookie, COOKIE_DOMAIN } from "@/lib/cookies";

export const runtime = "nodejs";

type IngestBody = {
  url: string;
  referrer?: string | null;
  utm?: Record<string, string | null | undefined>;
  click?: Record<string, string | null | undefined>;
  hubspotutk?: string | null;
};

function getIp(req: NextRequest): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip");
}

function now() {
  return new Date();
}

export async function OPTIONS(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  return withCors(res, req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const ua = req.headers.get("user-agent") ?? null;
  const ip = getIp(req);

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    const res = NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    return withCors(res, origin);
  }

  const existingVid = req.cookies.get("va_vid")?.value ?? null;
  const existingSid = req.cookies.get("va_sid")?.value ?? null;
  const existingAttrib = req.cookies.get("va_attrib")?.value ?? null;

  const vid = existingVid ?? randomId();
  const sid = existingSid ?? randomId();
  const attribTok = existingAttrib ?? randomId();

  await prisma.visitor.upsert({
    where: { id: vid },
    update: { lastSeenAt: now() },
    create: { id: vid, firstSeenAt: now() }
  });

  await prisma.session.upsert({
    where: { id: sid },
    update: { lastSeenAt: now() },
    create: {
      id: sid,
      visitorId: vid,
      firstSeenAt: now(),
      ipFirst: ip ?? undefined,
      uaFirst: ua ?? undefined
    }
  });

  const existing = await prisma.attribution.findUnique({ where: { token: attribTok } });
  const t = now();

  await prisma.attribution.upsert({
    where: { token: attribTok },
    update: {
      lastTouchAt: t,
      lastUrl: body.url,
      lastReferrer: body.referrer ?? null,

      utmSource: body.utm?.utm_source ?? existing?.utmSource ?? null,
      utmMedium: body.utm?.utm_medium ?? existing?.utmMedium ?? null,
      utmCampaign: body.utm?.utm_campaign ?? existing?.utmCampaign ?? null,
      utmTerm: body.utm?.utm_term ?? existing?.utmTerm ?? null,
      utmContent: body.utm?.utm_content ?? existing?.utmContent ?? null,

      gclid: body.click?.gclid ?? existing?.gclid ?? null,
      gbraid: body.click?.gbraid ?? existing?.gbraid ?? null,
      wbraid: body.click?.wbraid ?? existing?.wbraid ?? null,
      dclid: body.click?.dclid ?? existing?.dclid ?? null,

      fbclid: body.click?.fbclid ?? existing?.fbclid ?? null,
      fbp: body.click?.fbp ?? existing?.fbp ?? null,
      fbc: body.click?.fbc ?? existing?.fbc ?? null,

      ttclid: body.click?.ttclid ?? existing?.ttclid ?? null,
      msclkid: body.click?.msclkid ?? existing?.msclkid ?? null,

      hubspotutk: body.hubspotutk ?? existing?.hubspotutk ?? null,

      visitorId: vid,
      sessionId: sid
    },
    create: {
      token: attribTok,
      firstTouchAt: t,
      lastTouchAt: t,
      firstUrl: body.url,
      lastUrl: body.url,
      firstReferrer: body.referrer ?? null,
      lastReferrer: body.referrer ?? null,

      utmSource: body.utm?.utm_source ?? null,
      utmMedium: body.utm?.utm_medium ?? null,
      utmCampaign: body.utm?.utm_campaign ?? null,
      utmTerm: body.utm?.utm_term ?? null,
      utmContent: body.utm?.utm_content ?? null,

      gclid: body.click?.gclid ?? null,
      gbraid: body.click?.gbraid ?? null,
      wbraid: body.click?.wbraid ?? null,
      dclid: body.click?.dclid ?? null,

      fbclid: body.click?.fbclid ?? null,
      fbp: body.click?.fbp ?? null,
      fbc: body.click?.fbc ?? null,

      ttclid: body.click?.ttclid ?? null,
      msclkid: body.click?.msclkid ?? null,

      hubspotutk: body.hubspotutk ?? null,
      visitorId: vid,
      sessionId: sid
    }
  });

  const res = NextResponse.json({
    ok: true,
    vid,
    sid,
    attribTok,
    cookieDomain: COOKIE_DOMAIN
  });
  console.log("Attribution response:", { vid, sid, attribTok, cookieDomain: COOKIE_DOMAIN });
  setCookie(res, "va_vid", vid, 60 * 60 * 24 * 90);
  setCookie(res, "va_sid", sid, 60 * 60 * 24 * 30);
  setReadableCookie(res, "va_attrib", attribTok, 60 * 60 * 24 * 90);

  return withCors(res, origin);
}
