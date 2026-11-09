import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomId } from "@/lib/crypto";
import { withCors } from "@/lib/cors";
import { setCookie, setReadableCookie, COOKIE_DOMAIN, cookieDomainFor } from "@/lib/cookies";
import { ingestIdOrNull } from "@/lib/attribToken";

export const runtime = "nodejs";

type IngestBody = {
  url: string;
  referrer?: string | null;
  utm?: Record<string, string | null | undefined>;
  click?: Record<string, string | null | undefined>;
  hubspotutk?: string | null;
  // Sites other than virtu.academy (e.g. www.fortelessons.com) never get this service's
  // cookies back, so they keep the IDs from the response in their own first-party cookies
  // and send them here. Each is used only when its cookie is missing, and only if UUID-shaped.
  vid?: unknown;
  sid?: unknown;
  attribTok?: unknown;
};

function getIp(req: NextRequest): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip");
}

function now() {
  return new Date();
}

function normalizeValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const SESSION_WINDOW_MS = 30 * 60 * 1000;
const META_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

function buildFbp(createdAtMs: number): string {
  const random = Math.floor(1000000000 + Math.random() * 9000000000);
  return `fb.1.${createdAtMs}.${random}`;
}

function buildFbc(createdAtMs: number, fbclid: string): string {
  return `fb.1.${createdAtMs}.${fbclid}`;
}

export async function OPTIONS(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  return withCors(res, req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const ua = req.headers.get("user-agent") ?? null;
  const ip = getIp(req);
  // attrib.fortelessons.com sets its cookies on .fortelessons.com, attrib.virtu.academy on
  // .virtu.academy.
  const cookieDomain = cookieDomainFor(req.headers.get("host"));
  // Only virtu.academy lets this service create Meta's _fbp/_fbc cookies. fortelessons.com
  // allows no advertising cookie before consent; its Meta pixel sets them once consent is given.
  const mayCreateMetaCookies = cookieDomain === COOKIE_DOMAIN;

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    const res = NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    return withCors(res, origin);
  }

  const existingVid = req.cookies.get("va_vid")?.value ?? ingestIdOrNull(body?.vid);
  const existingSid = req.cookies.get("va_sid")?.value ?? ingestIdOrNull(body?.sid);
  // A malformed va_attrib cookie counts as missing (see ingestIdOrNull).
  const existingAttrib =
    ingestIdOrNull(req.cookies.get("va_attrib")?.value) ?? ingestIdOrNull(body?.attribTok);

  const t = now();
  const vid = existingVid ?? randomId();
  let sid = existingSid ?? null;
  const attribTok = existingAttrib ?? randomId();

  if (sid) {
    const existingSession = await prisma.session.findUnique({ where: { id: sid } });
    if (!existingSession) {
      sid = null;
    } else {
      const inactiveMs = t.getTime() - existingSession.lastSeenAt.getTime();
      if (inactiveMs > SESSION_WINDOW_MS) sid = null;
    }
  }

  if (!sid) sid = randomId();

  await prisma.visitor.upsert({
    where: { id: vid },
    update: { lastSeenAt: t },
    create: { id: vid, firstSeenAt: t },
  });

  await prisma.session.upsert({
    where: { id: sid },
    update: { lastSeenAt: t },
    create: {
      id: sid,
      visitorId: vid,
      firstSeenAt: t,
      ipFirst: ip ?? undefined,
      uaFirst: ua ?? undefined,
    },
  });

  const existing = await prisma.attribution.findUnique({ where: { token: attribTok } });
  const ipAddress = ip ?? null;
  const userAgent = ua ?? null;
  const utmSource = normalizeValue(body.utm?.utm_source);
  const utmMedium = normalizeValue(body.utm?.utm_medium);
  const utmCampaign = normalizeValue(body.utm?.utm_campaign);
  const utmTerm = normalizeValue(body.utm?.utm_term);
  const utmContent = normalizeValue(body.utm?.utm_content);

  const gclid = normalizeValue(body.click?.gclid);
  const gbraid = normalizeValue(body.click?.gbraid);
  const wbraid = normalizeValue(body.click?.wbraid);
  const dclid = normalizeValue(body.click?.dclid);
  const fbclid = normalizeValue(body.click?.fbclid);
  const fbpFromBody = normalizeValue(body.click?.fbp);
  const fbcFromBody = normalizeValue(body.click?.fbc);
  const fbpFromCookie = normalizeValue(req.cookies.get("_fbp")?.value);
  const fbcFromCookie = normalizeValue(req.cookies.get("_fbc")?.value);
  let fbp = fbpFromBody ?? fbpFromCookie ?? null;
  let fbc = fbcFromBody ?? fbcFromCookie ?? null;
  let setFbpCookie = false;
  let setFbcCookie = false;

  if (!fbp && mayCreateMetaCookies) {
    fbp = buildFbp(t.getTime());
    setFbpCookie = true;
  } else if (fbp && !fbpFromCookie) {
    setFbpCookie = mayCreateMetaCookies;
  }

  if (!fbc && fbclid) {
    // Stored either way: Meta accepts fbc built from fbclid. Only virtu.academy gets the cookie.
    fbc = buildFbc(t.getTime(), fbclid);
    setFbcCookie = mayCreateMetaCookies;
  } else if (fbc && !fbcFromCookie) {
    setFbcCookie = mayCreateMetaCookies;
  }
  const ttclid = normalizeValue(body.click?.ttclid);
  const ttp = normalizeValue(body.click?.ttp);
  const msclkid = normalizeValue(body.click?.msclkid);
  const hubspotutk = normalizeValue(body.hubspotutk);

  await prisma.attribution.upsert({
    where: { token: attribTok },
    update: {
      lastTouchAt: t,
      lastUrl: body.url,
      lastReferrer: body.referrer ?? null,
      ipAddress: ipAddress ?? existing?.ipAddress ?? null,
      userAgent: userAgent ?? existing?.userAgent ?? null,

      utmSource: utmSource ?? existing?.utmSource ?? null,
      utmMedium: utmMedium ?? existing?.utmMedium ?? null,
      utmCampaign: utmCampaign ?? existing?.utmCampaign ?? null,
      utmTerm: utmTerm ?? existing?.utmTerm ?? null,
      utmContent: utmContent ?? existing?.utmContent ?? null,

      gclid: gclid ?? existing?.gclid ?? null,
      gbraid: gbraid ?? existing?.gbraid ?? null,
      wbraid: wbraid ?? existing?.wbraid ?? null,
      dclid: dclid ?? existing?.dclid ?? null,

      fbclid: fbclid ?? existing?.fbclid ?? null,
      fbp: fbp ?? existing?.fbp ?? null,
      fbc: fbc ?? existing?.fbc ?? null,

      ttclid: ttclid ?? existing?.ttclid ?? null,
      ttp: ttp ?? existing?.ttp ?? null,
      msclkid: msclkid ?? existing?.msclkid ?? null,

      hubspotutk: hubspotutk ?? existing?.hubspotutk ?? null,

      visitorId: vid,
      sessionId: sid,
    },
    create: {
      token: attribTok,
      firstTouchAt: t,
      lastTouchAt: t,
      firstUrl: body.url,
      lastUrl: body.url,
      firstReferrer: body.referrer ?? null,
      lastReferrer: body.referrer ?? null,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,

      utmSource: utmSource ?? null,
      utmMedium: utmMedium ?? null,
      utmCampaign: utmCampaign ?? null,
      utmTerm: utmTerm ?? null,
      utmContent: utmContent ?? null,

      gclid: gclid ?? null,
      gbraid: gbraid ?? null,
      wbraid: wbraid ?? null,
      dclid: dclid ?? null,

      fbclid: fbclid ?? null,
      fbp: fbp ?? null,
      fbc: fbc ?? null,

      ttclid: ttclid ?? null,
      ttp: ttp ?? null,
      msclkid: msclkid ?? null,

      hubspotutk: hubspotutk ?? null,
      visitorId: vid,
      sessionId: sid,
    },
  });

  const res = NextResponse.json({
    ok: true,
    vid,
    sid,
    attribTok,
    cookieDomain,
  });
  setCookie(res, "va_vid", vid, 60 * 60 * 24 * 90, cookieDomain);
  setCookie(res, "va_sid", sid, 60 * 60 * 24 * 30, cookieDomain);
  setReadableCookie(res, "va_attrib", attribTok, 60 * 60 * 24 * 90, cookieDomain);
  if (setFbpCookie && fbp) {
    setReadableCookie(res, "_fbp", fbp, META_COOKIE_MAX_AGE_SECONDS, cookieDomain);
  }
  if (setFbcCookie && fbc) {
    setReadableCookie(res, "_fbc", fbc, META_COOKIE_MAX_AGE_SECONDS, cookieDomain);
  }

  return withCors(res, origin);
}
