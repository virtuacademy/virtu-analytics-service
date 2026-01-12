"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { FilterBar } from "./FilterBar";

type Appointment = {
  id: string;
  appointmentTypeId: string | null;
  status: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  vaAttrib: string | null;
  gclid: string | null;
  ttclid: string | null;
  fbp: string | null;
  fbc: string | null;
  updatedAt: Date;
  scheduledBy: string | null;
};

type AppointmentsSectionProps = {
  appointments: Appointment[];
  trialAppointmentTypes: string[];
  selectedAppointmentId: string | null;
};

type FilterType = "all" | "trial" | "leads";

const FILTER_OPTIONS = [
  {
    id: "all",
    label: "All",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 6h16M4 10h16M4 14h16M4 18h16"
        />
      </svg>
    ),
  },
  {
    id: "trial",
    label: "Trial Only",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    id: "leads",
    label: "Leads Only",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
        />
      </svg>
    ),
  },
];

export function AppointmentsSection({
  appointments,
  trialAppointmentTypes,
  selectedAppointmentId,
}: AppointmentsSectionProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Derive initial filter from URL
  const getInitialFilter = (): FilterType => {
    if (searchParams.get("leads") === "1") return "leads";
    if (searchParams.get("trial") === "1") return "trial";
    return "all";
  };

  const [filter, setFilter] = useState<FilterType>(getInitialFilter);
  const [isExpanded, setIsExpanded] = useState(true);

  // Filter appointments based on current filter
  const filteredAppointments = useMemo(() => {
    switch (filter) {
      case "trial":
        return appointments.filter(
          (appt) =>
            appt.appointmentTypeId && trialAppointmentTypes.includes(appt.appointmentTypeId),
        );
      case "leads":
        // Leads only: scheduledBy is blank/null (self-scheduled)
        return appointments.filter((appt) => !appt.scheduledBy || appt.scheduledBy.trim() === "");
      default:
        return appointments;
    }
  }, [appointments, filter, trialAppointmentTypes]);

  // Handle filter change - update URL without scroll
  const handleFilterChange = useCallback(
    (newFilter: string) => {
      setFilter(newFilter as FilterType);

      // Update URL params without scrolling
      const params = new URLSearchParams(searchParams.toString());
      params.delete("trial");
      params.delete("leads");

      if (newFilter === "trial") {
        params.set("trial", "1");
      } else if (newFilter === "leads") {
        params.set("leads", "1");
      }

      const newUrl = params.toString() ? `/?${params.toString()}` : "/";
      router.push(newUrl, { scroll: false });
    },
    [router, searchParams],
  );

  // Handle appointment selection
  const handleSelectAppointment = useCallback(
    (appointmentId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("appt", appointmentId);
      router.push(`/?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <section className="mb-12">
      {/* Header with collapsible toggle and filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="group flex items-center gap-2"
        >
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <svg
              className="w-5 h-5 text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            Appointments
          </h2>
          <svg
            className={`w-5 h-5 text-zinc-400 transition-transform duration-200 ${
              isExpanded ? "rotate-180" : ""
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <span className="ml-2 text-xs text-zinc-500 font-normal">
            {filteredAppointments.length} result{filteredAppointments.length !== 1 ? "s" : ""}
          </span>
        </button>

        {/* Filter controls - only show when expanded */}
        {isExpanded && (
          <FilterBar
            options={FILTER_OPTIONS}
            value={filter}
            onChange={handleFilterChange}
            label="Filter"
          />
        )}
      </div>

      {/* Table content */}
      {isExpanded && (
        <div className="overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900/30 backdrop-blur-sm animate-in slide-in-from-top-4 duration-300">
          {filteredAppointments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <svg
                className="w-12 h-12 text-zinc-600 mb-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-sm text-zinc-400 text-center">
                No appointments found for the selected filter.
              </p>
              <button
                onClick={() => handleFilterChange("all")}
                className="mt-4 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-gradient-to-r from-zinc-900 to-zinc-900/80 sticky top-0 z-10">
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    ID
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Type
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Scheduled By
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Email
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Phone
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    VA Attrib
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    GCLID
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    TTCLID
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Updated
                  </th>
                  <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {filteredAppointments.map((appt) => {
                  const isSelected = selectedAppointmentId === appt.id;
                  return (
                    <tr
                      key={appt.id}
                      className={`transition-colors hover:bg-zinc-800/30 ${
                        isSelected ? "bg-blue-500/10 border-l-2 border-l-blue-500" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-blue-400">{appt.id}</td>
                      <td className="px-4 py-3 text-xs text-zinc-200">
                        {appt.appointmentTypeId ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-200">
                        {appt.scheduledBy ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                            {appt.scheduledBy}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                            Self
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-400">
                          {appt.status ?? "-"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-300">{appt.email ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-zinc-300">{appt.phone ?? "-"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-purple-400">
                        {appt.vaAttrib ?? "-"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                        {appt.gclid ?? "-"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                        {appt.ttclid ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-zinc-500">
                        {appt.updatedAt.toISOString()}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleSelectAppointment(appt.id)}
                          className="group inline-flex items-center gap-1 text-xs text-blue-400 transition-colors hover:text-blue-300"
                        >
                          <span>View</span>
                          <svg
                            className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
