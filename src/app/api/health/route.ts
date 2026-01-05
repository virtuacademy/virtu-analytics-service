import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function redactDbInfo() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return {
      host: url.hostname,
      database: url.pathname.replace("/", "") || null
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const [attribCount, apptCount, eventCount] = await Promise.all([
    prisma.attribution.count(),
    prisma.appointment.count(),
    prisma.canonicalEvent.count()
  ]);

  return NextResponse.json({
    ok: true,
    db: redactDbInfo(),
    counts: {
      attributions: attribCount,
      appointments: apptCount,
      canonicalEvents: eventCount
    }
  });
}
