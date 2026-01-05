import { unstable_noStore as noStore } from "next/cache";
import { prisma } from "@/lib/prisma";
import { AppointmentModal } from "./components/AppointmentModal";
import { CollapsibleAttributions } from "./components/CollapsibleAttributions";
import { CollapsibleCanonicalEvents } from "./components/CollapsibleCanonicalEvents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAL_APPOINTMENT_TYPES = (process.env.ACUITY_TRIAL_APPOINTMENT_TYPE_IDS ?? "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

type SearchParams = {
  trial?: string;
  appt?: string;
};

export default async function Home({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  noStore();
  const resolvedSearchParams = await searchParams;
  const trialOnly =
    resolvedSearchParams?.trial === "1" || resolvedSearchParams?.trial === "true";
  const selectedAppointmentId =
    resolvedSearchParams?.appt && typeof resolvedSearchParams.appt === "string"
      ? resolvedSearchParams.appt
      : null;
  const appointmentWhere = trialOnly
    ? { appointmentTypeId: { in: TRIAL_APPOINTMENT_TYPES } }
    : undefined;

  const appointments = await prisma.appointment.findMany({
    where: appointmentWhere,
    orderBy: { updatedAt: "desc" },
    take: 25
  });

  const selectedAppointment = selectedAppointmentId
    ? await prisma.appointment.findUnique({ where: { id: selectedAppointmentId } })
    : null;
  const selectedAttribution = selectedAppointment?.vaAttrib
    ? await prisma.attribution.findUnique({ where: { token: selectedAppointment.vaAttrib } })
    : null;

  const baseParams = new URLSearchParams();
  if (selectedAppointmentId) baseParams.set("appt", selectedAppointmentId);
  const allHref = baseParams.toString() ? `/?${baseParams.toString()}` : "/";
  const trialParams = new URLSearchParams(baseParams);
  trialParams.set("trial", "1");
  const trialHref = `/?${trialParams.toString()}`;
  const clearHref = trialOnly ? "/?trial=1" : "/";

  const attributions = await prisma.attribution.findMany({
    orderBy: { lastTouchAt: "desc" },
    take: 25
  });

  const canonicalEvents = await prisma.canonicalEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { deliveries: true }
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
            Real-time insights into appointments, attribution tracking, and event delivery across all platforms.
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

        <CollapsibleAttributions
          attributions={attributions}
          selectedToken={selectedAttribution?.token ?? null}
        />

        <section className="mb-12">
          <div className="flex items-center justify-between gap-4 mb-6">
            <h2 className="text-2xl font-semibold flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Appointments
            </h2>
            <div className="flex flex-wrap gap-2">
              <a
                className={`group relative overflow-hidden rounded-full border px-4 py-2 text-xs font-medium transition-all ${
                  trialOnly
                    ? "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                    : "border-blue-500/50 bg-blue-500/10 text-blue-300 shadow-lg shadow-blue-500/20"
                }`}
                href={allHref}
              >
                {!trialOnly && (
                  <span className="absolute inset-0 bg-gradient-to-r from-blue-500/20 to-transparent" />
                )}
                <span className="relative">All</span>
              </a>
              <a
                className={`group relative overflow-hidden rounded-full border px-4 py-2 text-xs font-medium transition-all ${
                  trialOnly
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-300 shadow-lg shadow-blue-500/20"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                }`}
                href={trialHref}
              >
                {trialOnly && (
                  <span className="absolute inset-0 bg-gradient-to-r from-blue-500/20 to-transparent" />
                )}
                <span className="relative">Trial only</span>
              </a>
            </div>
          </div>
          <div className="overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900/30 backdrop-blur-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-gradient-to-r from-zinc-900 to-zinc-900/80">
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">ID</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Type</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Scheduled By</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Status</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Email</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Phone</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">VA Attrib</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">GCLID</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">TTCLID</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Updated</th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {appointments.map(appt => {
                  const apptParams = new URLSearchParams();
                  if (trialOnly) apptParams.set("trial", "1");
                  apptParams.set("appt", appt.id);
                  const apptHref = `/?${apptParams.toString()}`;
                  const isSelected = selectedAppointmentId === appt.id;
                  return (
                    <tr
                      key={appt.id}
                      className={`transition-colors hover:bg-zinc-800/30 ${
                        isSelected ? "bg-blue-500/10 border-l-2 border-l-blue-500" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-blue-400">{appt.id}</td>
                      <td className="px-4 py-3 text-xs text-zinc-200">{appt.appointmentTypeId ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-zinc-200">{appt.scheduledBy ?? "-"}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-400">
                          {appt.status ?? "-"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-300">{appt.email ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-zinc-300">{appt.phone ?? "-"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-purple-400">{appt.vaAttrib ?? "-"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">{appt.gclid ?? "-"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">{appt.ttclid ?? "-"}</td>
                      <td className="px-4 py-3 text-[11px] text-zinc-500">
                        {appt.updatedAt.toISOString()}
                      </td>
                      <td className="px-4 py-3">
                        <a
                          className="group inline-flex items-center gap-1 text-xs text-blue-400 transition-colors hover:text-blue-300"
                          href={apptHref}
                        >
                          <span>View</span>
                          <svg className="h-3 w-3 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <CollapsibleCanonicalEvents canonicalEvents={canonicalEvents} />
      </div>
    </main>
  );
}
