import { unstable_noStore as noStore } from "next/cache";
import { prisma } from "@/lib/prisma";
import { AppointmentModal } from "./components/AppointmentModal";
import { AppointmentsSection } from "./components/AppointmentsSection";
import { CollapsibleAttributions } from "./components/CollapsibleAttributions";
import { CollapsibleCanonicalEvents } from "./components/CollapsibleCanonicalEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAL_APPOINTMENT_TYPES = (process.env.ACUITY_TRIAL_APPOINTMENT_TYPE_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

type SearchParams = {
  trial?: string;
  leads?: string;
  appt?: string;
};

export default async function Home({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  noStore();
  const resolvedSearchParams = await searchParams;
  const selectedAppointmentId =
    resolvedSearchParams?.appt && typeof resolvedSearchParams.appt === "string"
      ? resolvedSearchParams.appt
      : null;

  // Fetch all appointments - filtering is handled client-side for better UX
  const appointments = await prisma.appointment.findMany({
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const selectedAppointment = selectedAppointmentId
    ? await prisma.appointment.findUnique({ where: { id: selectedAppointmentId } })
    : null;
  const selectedAttribution = selectedAppointment?.vaAttrib
    ? await prisma.attribution.findUnique({ where: { token: selectedAppointment.vaAttrib } })
    : null;

  // Build clear href based on current filters
  const clearParams = new URLSearchParams();
  if (resolvedSearchParams?.trial === "1") clearParams.set("trial", "1");
  if (resolvedSearchParams?.leads === "1") clearParams.set("leads", "1");
  const clearHref = clearParams.toString() ? `/?${clearParams.toString()}` : "/";

  const attributions = await prisma.attribution.findMany({
    orderBy: { lastTouchAt: "desc" },
    take: 25,
  });

  const canonicalEvents = await prisma.canonicalEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { deliveries: true },
  });

  return (
    <main className="min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <header className="relative mb-12 flex flex-col gap-3">
          <div className="absolute -left-4 top-0 h-16 w-1 bg-gradient-to-b from-blue-500 to-purple-500 rounded-full" />
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Virtu Analytics
          </h1>
          <p className="text-sm text-zinc-400 max-w-2xl">
            Real-time insights into appointments, attribution tracking, and event delivery across
            all platforms.
          </p>
        </header>

        {/* Modal for selected appointment */}
        {selectedAppointmentId && selectedAppointment && (
          <AppointmentModal
            appointment={selectedAppointment}
            attribution={selectedAttribution}
            clearHref={clearHref}
          />
        )}

        <AppointmentsSection
          appointments={appointments}
          trialAppointmentTypes={TRIAL_APPOINTMENT_TYPES}
          selectedAppointmentId={selectedAppointmentId}
        />

        <CollapsibleAttributions
          attributions={attributions}
          selectedToken={selectedAttribution?.token ?? null}
        />

        <CollapsibleCanonicalEvents canonicalEvents={canonicalEvents} />
      </div>
    </main>
  );
}
