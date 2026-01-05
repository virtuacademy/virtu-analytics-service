import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export default async function Home() {
  const appointments = await prisma.appointment.findMany({
    orderBy: { updatedAt: "desc" },
    take: 25
  });

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
                {attributions.map(attrib => (
                  <tr key={attrib.token} className="border-t border-zinc-800">
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
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium">Appointments</h2>
          <div className="mt-3 overflow-auto rounded-xl border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">va_attrib</th>
                  <th className="px-3 py-2">gclid</th>
                  <th className="px-3 py-2">ttclid</th>
                  <th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map(appt => (
                  <tr key={appt.id} className="border-t border-zinc-800">
                    <td className="px-3 py-2 font-mono text-xs">{appt.id}</td>
                    <td className="px-3 py-2">{appt.appointmentTypeId ?? "-"}</td>
                    <td className="px-3 py-2">{appt.status ?? "-"}</td>
                    <td className="px-3 py-2">{appt.email ?? "-"}</td>
                    <td className="px-3 py-2">{appt.phone ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{appt.vaAttrib ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{appt.gclid ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{appt.ttclid ?? "-"}</td>
                    <td className="px-3 py-2 text-xs text-zinc-400">
                      {appt.updatedAt.toISOString()}
                    </td>
                  </tr>
                ))}
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
