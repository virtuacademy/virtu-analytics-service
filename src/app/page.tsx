import { unstable_noStore as noStore } from "next/cache";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TRIAL_APPOINTMENT_TYPES = ["37436265", "37436299"];

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
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold">Virtu Analytics Debug</h1>
          <p className="text-sm text-zinc-400">
            Recent appointments, canonical events, and delivery results.
          </p>
        </header>

        {selectedAppointmentId ? (
          <section id="selected-appointment" className="mt-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-medium">Selected Appointment</h2>
              <a className="text-xs text-zinc-400 hover:text-zinc-200" href={clearHref}>
                Clear selection
              </a>
            </div>
            {selectedAppointment ? (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 p-4">
                  <h3 className="text-sm font-medium text-zinc-200">Appointment</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-zinc-500">ID</dt>
                      <dd className="font-mono text-[11px]">{selectedAppointment.id}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Type</dt>
                      <dd>{selectedAppointment.appointmentTypeId ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Scheduled By</dt>
                      <dd>{selectedAppointment.scheduledBy ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Status</dt>
                      <dd>{selectedAppointment.status ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Name</dt>
                      <dd>
                        {[selectedAppointment.firstName, selectedAppointment.lastName]
                          .filter(Boolean)
                          .join(" ") || "-"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Email</dt>
                      <dd className="break-all">{selectedAppointment.email ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Phone</dt>
                      <dd>{selectedAppointment.phone ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">va_attrib</dt>
                      <dd className="font-mono text-[11px]">{selectedAppointment.vaAttrib ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">gclid</dt>
                      <dd className="font-mono text-[11px]">{selectedAppointment.gclid ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">ttclid</dt>
                      <dd className="font-mono text-[11px]">{selectedAppointment.ttclid ?? "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Updated</dt>
                      <dd>{selectedAppointment.updatedAt.toISOString()}</dd>
                    </div>
                  </dl>
                </div>
                <div className="rounded-xl border border-zinc-800 p-4">
                  <h3 className="text-sm font-medium text-zinc-200">Attribution</h3>
                  {selectedAttribution ? (
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-zinc-500">Token</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.token}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Last Touch</dt>
                        <dd>{selectedAttribution.lastTouchAt.toISOString()}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Last URL</dt>
                        <dd className="break-all">{selectedAttribution.lastUrl ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Referrer</dt>
                        <dd className="break-all">{selectedAttribution.lastReferrer ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">utm_source</dt>
                        <dd>{selectedAttribution.utmSource ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">utm_medium</dt>
                        <dd>{selectedAttribution.utmMedium ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">utm_campaign</dt>
                        <dd>{selectedAttribution.utmCampaign ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">utm_term</dt>
                        <dd>{selectedAttribution.utmTerm ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">utm_content</dt>
                        <dd>{selectedAttribution.utmContent ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">gclid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.gclid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">gbraid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.gbraid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">wbraid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.wbraid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">dclid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.dclid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">fbclid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.fbclid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">fbp</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.fbp ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">fbc</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.fbc ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">ttclid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.ttclid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">msclkid</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.msclkid ?? "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">hubspotutk</dt>
                        <dd className="font-mono text-[11px]">{selectedAttribution.hubspotutk ?? "-"}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 text-xs text-zinc-400">
                      No attribution found for token {selectedAppointment.vaAttrib ?? "-"}.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-zinc-400">Appointment not found.</p>
            )}
          </section>
        ) : null}

        <section className="mt-10">
          <h2 className="text-lg font-medium">Attributions</h2>
          <div className="mt-3 overflow-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2">Last URL</th>
                  <th className="px-3 py-2">Referrer</th>
                  <th className="px-3 py-2">utm_source</th>
                  <th className="px-3 py-2">utm_medium</th>
                  <th className="px-3 py-2">utm_campaign</th>
                  <th className="px-3 py-2">gclid</th>
                  <th className="px-3 py-2">ttclid</th>
                  <th className="px-3 py-2">Last Touch</th>
                </tr>
              </thead>
              <tbody>
                {attributions.map(attrib => {
                  const isSelected = selectedAttribution?.token === attrib.token;
                  return (
                    <tr
                      key={attrib.token}
                      className={`border-t border-zinc-800 ${isSelected ? "bg-zinc-900/60" : ""}`}
                    >
                    <td className="px-3 py-2 font-mono text-xs">{attrib.token}</td>
                    <td className="px-3 py-2">{attrib.lastUrl ?? "-"}</td>
                    <td className="px-3 py-2">{attrib.lastReferrer ?? "-"}</td>
                    <td className="px-3 py-2">{attrib.utmSource ?? "-"}</td>
                    <td className="px-3 py-2">{attrib.utmMedium ?? "-"}</td>
                    <td className="px-3 py-2">{attrib.utmCampaign ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{attrib.gclid ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{attrib.ttclid ?? "-"}</td>
                    <td className="px-3 py-2 text-xs text-zinc-400">
                      {attrib.lastTouchAt.toISOString()}
                    </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Appointments</h2>
            <div className="flex flex-wrap gap-2 text-xs">
              <a
                className={`rounded-full border px-3 py-1 ${
                  trialOnly
                    ? "border-zinc-800 text-zinc-400 hover:text-zinc-200"
                    : "border-zinc-600 text-zinc-100"
                }`}
                href={allHref}
              >
                All
              </a>
              <a
                className={`rounded-full border px-3 py-1 ${
                  trialOnly
                    ? "border-zinc-600 text-zinc-100"
                    : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
                href={trialHref}
              >
                Trial only
              </a>
            </div>
          </div>
          <div className="mt-3 overflow-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Scheduled By</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">va_attrib</th>
                  <th className="px-3 py-2">gclid</th>
                  <th className="px-3 py-2">ttclid</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">View</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map(appt => {
                  const apptParams = new URLSearchParams();
                  if (trialOnly) apptParams.set("trial", "1");
                  apptParams.set("appt", appt.id);
                  const apptHref = `/?${apptParams.toString()}#selected-appointment`;
                  const isSelected = selectedAppointmentId === appt.id;
                  return (
                    <tr
                      key={appt.id}
                      className={`border-t border-zinc-800 ${isSelected ? "bg-zinc-900/60" : ""}`}
                    >
                      <td className="px-3 py-2 font-mono text-xs">{appt.id}</td>
                      <td className="px-3 py-2">{appt.appointmentTypeId ?? "-"}</td>
                      <td className="px-3 py-2">{appt.scheduledBy ?? "-"}</td>
                      <td className="px-3 py-2">{appt.status ?? "-"}</td>
                      <td className="px-3 py-2">{appt.email ?? "-"}</td>
                      <td className="px-3 py-2">{appt.phone ?? "-"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{appt.vaAttrib ?? "-"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{appt.gclid ?? "-"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{appt.ttclid ?? "-"}</td>
                      <td className="px-3 py-2 text-xs text-zinc-400">
                        {appt.updatedAt.toISOString()}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <a className="text-blue-300 hover:text-blue-200" href={apptHref}>
                          View
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium">Canonical Events</h2>
          <div className="mt-3 overflow-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Appointment</th>
                  <th className="px-3 py-2">Attrib</th>
                  <th className="px-3 py-2">Event ID</th>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Deliveries</th>
                </tr>
              </thead>
              <tbody>
                {canonicalEvents.map(ce => (
                  <tr key={ce.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2">{ce.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{ce.appointmentId ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{ce.attributionTok ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{ce.eventId}</td>
                    <td className="px-3 py-2 text-xs text-zinc-400">
                      {ce.eventTime.toISOString()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="flex flex-wrap gap-2">
                        {ce.deliveries.map(d => (
                          <span
                            key={d.id}
                            className="rounded-full border border-zinc-700 px-2 py-1 text-[11px]"
                          >
                            {d.platform}:{d.status}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
