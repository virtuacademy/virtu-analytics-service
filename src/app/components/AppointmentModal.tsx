"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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
  updatedAt: Date;
  scheduledBy?: string | null;
};

type Attribution = {
  token: string;
  lastTouchAt: Date;
  lastUrl: string | null;
  lastReferrer: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  dclid: string | null;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  ttclid: string | null;
  msclkid: string | null;
  hubspotutk: string | null;
};

type AppointmentModalProps = {
  appointment: Appointment;
  attribution: Attribution | null;
  clearHref: string;
};

export function AppointmentModal({ appointment, attribution, clearHref }: AppointmentModalProps) {
  const router = useRouter();
  const [attributionExpanded, setAttributionExpanded] = useState(false);

  useEffect(() => {
    // Prevent body scroll when modal is open
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, []);

  const handleClose = () => {
    router.push(clearHref);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={handleBackdropClick}
    >
      <div className="relative max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-950 to-zinc-900 shadow-2xl animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur-sm">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            Appointment Details
          </h2>
          <button
            onClick={handleClose}
            className="group rounded-lg p-2 transition-colors hover:bg-zinc-800"
          >
            <svg
              className="h-5 w-5 text-zinc-400 transition-colors group-hover:text-zinc-200"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Appointment Info */}
          <div className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900/50 to-zinc-900/30 p-6 backdrop-blur-sm">
            <h3 className="text-sm font-semibold text-blue-400 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              Appointment Details
            </h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-xs">
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  ID
                </dt>
                <dd className="font-mono text-[11px] text-zinc-200">{appointment.id}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Type
                </dt>
                <dd className="text-zinc-200">{appointment.appointmentTypeId ?? "-"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Scheduled By
                </dt>
                <dd className="text-zinc-200">{appointment.scheduledBy ?? "-"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Status
                </dt>
                <dd className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-1 text-[10px] font-medium text-emerald-400">
                  {appointment.status ?? "-"}
                </dd>
              </div>
              <div className="space-y-1 col-span-2">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Name
                </dt>
                <dd className="text-zinc-200">
                  {[appointment.firstName, appointment.lastName].filter(Boolean).join(" ") || "-"}
                </dd>
              </div>
              <div className="space-y-1 col-span-2">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Email
                </dt>
                <dd className="break-all text-zinc-200">{appointment.email ?? "-"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Phone
                </dt>
                <dd className="text-zinc-200">{appointment.phone ?? "-"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  VA Attrib
                </dt>
                <dd className="font-mono text-[11px] text-purple-400">
                  {appointment.vaAttrib ?? "-"}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  GCLID
                </dt>
                <dd className="font-mono text-[11px] text-zinc-400">{appointment.gclid ?? "-"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  TTCLID
                </dt>
                <dd className="font-mono text-[11px] text-zinc-400">{appointment.ttclid ?? "-"}</dd>
              </div>
              <div className="space-y-1 col-span-2">
                <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                  Last Updated
                </dt>
                <dd className="text-zinc-400 text-[11px]">{appointment.updatedAt.toISOString()}</dd>
              </div>
            </dl>
          </div>

          {/* Attribution Info */}
          <div className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900/50 to-zinc-900/30 p-6 backdrop-blur-sm">
            <button
              onClick={() => setAttributionExpanded(!attributionExpanded)}
              className="w-full flex items-center justify-between text-sm font-semibold text-purple-400 mb-4 group"
            >
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                Attribution Data
              </span>
              <svg
                className={`w-4 h-4 transition-transform ${
                  attributionExpanded ? "rotate-180" : ""
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
            {attribution ? (
              <>
                {/* Always visible summary */}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-xs mb-4">
                  <div className="space-y-1 col-span-2">
                    <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                      Token
                    </dt>
                    <dd className="font-mono text-[11px] text-purple-400">{attribution.token}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                      UTM Source
                    </dt>
                    <dd className="text-zinc-200">{attribution.utmSource ?? "-"}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                      UTM Medium
                    </dt>
                    <dd className="text-zinc-200">{attribution.utmMedium ?? "-"}</dd>
                  </div>
                </dl>

                {/* Collapsible details */}
                {attributionExpanded && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-xs border-t border-zinc-800 pt-4 animate-in slide-in-from-top-2 duration-200">
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        Last Touch
                      </dt>
                      <dd className="text-zinc-400 text-[11px]">
                        {attribution.lastTouchAt.toISOString()}
                      </dd>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        Last URL
                      </dt>
                      <dd className="break-all text-zinc-300 text-[11px]">
                        {attribution.lastUrl ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        Referrer
                      </dt>
                      <dd className="break-all text-zinc-300 text-[11px]">
                        {attribution.lastReferrer ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        IP Address
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.ipAddress ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        User Agent
                      </dt>
                      <dd className="break-all text-zinc-300 text-[11px]">
                        {attribution.userAgent ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        UTM Campaign
                      </dt>
                      <dd className="text-zinc-200">{attribution.utmCampaign ?? "-"}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        UTM Term
                      </dt>
                      <dd className="text-zinc-200">{attribution.utmTerm ?? "-"}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        UTM Content
                      </dt>
                      <dd className="text-zinc-200">{attribution.utmContent ?? "-"}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        GCLID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.gclid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        GBRAID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.gbraid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        WBRAID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.wbraid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        DCLID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.dclid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        FBCLID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.fbclid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        FBP
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.fbp ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        FBC
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.fbc ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        TTCLID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.ttclid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        MSCLKID
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.msclkid ?? "-"}
                      </dd>
                    </div>
                    <div className="space-y-1 col-span-2">
                      <dt className="text-zinc-500 text-[10px] uppercase tracking-wider font-medium">
                        HubSpot UTK
                      </dt>
                      <dd className="font-mono text-[11px] text-zinc-400">
                        {attribution.hubspotutk ?? "-"}
                      </dd>
                    </div>
                  </dl>
                )}
              </>
            ) : (
              <p className="text-xs text-zinc-400">
                No attribution found for token {appointment.vaAttrib ?? "-"}.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
