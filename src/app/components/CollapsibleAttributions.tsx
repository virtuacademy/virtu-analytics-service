"use client";

import { useState } from "react";

type Attribution = {
  token: string;
  lastUrl: string | null;
  lastReferrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  gclid: string | null;
  ttclid: string | null;
  lastTouchAt: Date;
};

type CollapsibleAttributionsProps = {
  attributions: Attribution[];
  selectedToken: string | null;
};

export function CollapsibleAttributions({
  attributions,
  selectedToken,
}: CollapsibleAttributionsProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <section className="mb-12">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex items-center gap-2 mb-6"
      >
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Attributions
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
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Token</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Last URL</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Referrer</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">UTM Source</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">UTM Medium</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">UTM Campaign</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">GCLID</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">TTCLID</th>
                <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Last Touch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {attributions.map(attrib => {
                const isSelected = selectedToken === attrib.token;
                return (
                  <tr
                    key={attrib.token}
                    className={`transition-colors hover:bg-zinc-800/30 ${
                      isSelected ? "bg-purple-500/10 border-l-2 border-l-purple-500" : ""
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-purple-400">{attrib.token}</td>
                    <td className="px-4 py-3 text-xs text-zinc-300 max-w-xs truncate">{attrib.lastUrl ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-zinc-300 max-w-xs truncate">{attrib.lastReferrer ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-zinc-200">{attrib.utmSource ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-zinc-200">{attrib.utmMedium ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-zinc-200">{attrib.utmCampaign ?? "-"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{attrib.gclid ?? "-"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{attrib.ttclid ?? "-"}</td>
                    <td className="px-4 py-3 text-[11px] text-zinc-500">
                      {attrib.lastTouchAt.toISOString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
