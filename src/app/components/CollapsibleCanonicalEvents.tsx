"use client";

import { useState } from "react";

type Delivery = {
  id: string;
  platform: string;
  status: string;
};

type CanonicalEvent = {
  id: string;
  name: string;
  appointmentId: string | null;
  attributionTok: string | null;
  eventId: string;
  eventTime: Date;
  deliveries: Delivery[];
};

type CollapsibleCanonicalEventsProps = {
  canonicalEvents: CanonicalEvent[];
};

export function CollapsibleCanonicalEvents({
  canonicalEvents,
}: CollapsibleCanonicalEventsProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <section className="mb-12">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex items-center gap-2 mb-6"
      >
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <svg className="w-5 h-5 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
            />
          </svg>
          Canonical Events
        </h2>
        <svg
          className={`w-5 h-5 text-zinc-400 transition-transform ${
            isExpanded ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900/30 backdrop-blur-sm animate-in slide-in-from-top-4 duration-300">
          <table className="w-full text-left text-sm">
            <thead className="bg-gradient-to-r from-zinc-900 to-zinc-900/80">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Event
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Appointment
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Attribution
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Event ID
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Time
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  Deliveries
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {canonicalEvents.map(ce => (
                <tr key={ce.id} className="transition-colors hover:bg-zinc-800/30">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-pink-500/10 px-2.5 py-1 text-xs font-medium text-pink-400">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-pink-400" />
                      {ce.name}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-blue-400">
                    {ce.appointmentId ?? "-"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-purple-400">
                    {ce.attributionTok ?? "-"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-400">{ce.eventId}</td>
                  <td className="px-4 py-3 text-[11px] text-zinc-500">
                    {ce.eventTime.toISOString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {ce.deliveries.map(d => (
                        <span
                          key={d.id}
                          className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium ${
                            d.status === "SUCCESS"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : d.status === "PENDING"
                              ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                              : "bg-red-500/10 text-red-400 border border-red-500/20"
                          }`}
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
      )}
    </section>
  );
}
