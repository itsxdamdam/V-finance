"use client";

import { useEffect, useMemo, useState } from "react";

const TICKERS = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "ITC",
  "SBIN",
  "TATAMOTORS",
];

const labelColors: Record<string, string> = {
  Bullish: "bg-green-500/20 text-green-300 border-green-500/40",
  Bearish: "bg-red-500/20 text-red-300 border-red-500/40",
  Neutral: "bg-slate-500/20 text-slate-200 border-slate-500/40",
  Positive: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
  Negative: "bg-rose-500/20 text-rose-200 border-rose-500/40",
  Supportive: "bg-blue-500/20 text-blue-200 border-blue-500/40",
  Cautionary: "bg-amber-500/20 text-amber-200 border-amber-500/40",
  "No-evidence": "bg-slate-600/20 text-slate-200 border-slate-600/40",
  Spike: "bg-violet-500/20 text-violet-200 border-violet-500/40",
  "Drying-up": "bg-orange-500/20 text-orange-200 border-orange-500/40",
  Normal: "bg-slate-500/20 text-slate-200 border-slate-500/40",
  ok: "bg-emerald-500/20 text-emerald-200",
  degraded: "bg-amber-500/20 text-amber-200",
};

function formatNumber(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return "0";
  return value.toFixed(2);
}

export default function HomePage() {
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [profileName, setProfileName] = useState("Moderate");
  const [ticker, setTicker] = useState("RELIANCE");
  const [feedDown, setFeedDown] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [analysis, setAnalysis] = useState<any>(null);
  const [compareData, setCompareData] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);

  useEffect(() => {
    fetch("/api/profiles")
      .then((res) => res.json())
      .then((data) => {
        setProfiles(data);
        if (!data[profileName]) setProfileName("Moderate");
      });
  }, []);

  const loadAnalysis = async (selectedProfile = profileName) => {
    const url = `/api/analyze?ticker=${encodeURIComponent(ticker)}&profile=${encodeURIComponent(selectedProfile)}&feedDown=${feedDown ? "1" : "0"}&conflict=${conflict ? "1" : "0"}`;
    const res = await fetch(url);
    const data = await res.json();
    setAnalysis(data);
  };

  const loadMetrics = async (selectedProfile = profileName) => {
    const res = await fetch(
      `/api/metrics?profile=${encodeURIComponent(selectedProfile)}`,
    );
    const data = await res.json();
    setMetrics(data);
  };

  useEffect(() => {
    if (Object.keys(profiles).length) {
      loadAnalysis();
      loadMetrics();
    }
  }, [ticker, profileName, feedDown, conflict, profiles]);

  const compareProfiles = async () => {
    const names = Object.keys(profiles);
    const result = await Promise.all(
      names.map(async (name) => {
        const res = await fetch(
          `/api/analyze?ticker=${encodeURIComponent(ticker)}&profile=${encodeURIComponent(name)}&feedDown=${feedDown ? "1" : "0"}&conflict=${conflict ? "1" : "0"}`,
        );
        return res.json();
      }),
    );
    setCompareData(result);
  };

  const profileData = profiles[profileName] ?? {};

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">
                PS 04 • hackathon demo
              </p>
              <h1 className="mt-2 text-3xl font-bold text-white">V-Finance</h1>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1">
                Synthetic market
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1">
                No external APIs
              </span>
            </div>
          </div>
        </header>

        <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="text-sm text-slate-300">
              <span className="mb-2 block">Profile</span>
              <select
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                className="w-full p-2"
              >
                {Object.keys(profiles).map((profile) => (
                  <option key={profile} value={profile}>
                    {profile}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-300">
              <span className="mb-2 block">Ticker</span>
              <select
                value={ticker}
                onChange={(event) => setTicker(event.target.value)}
                className="w-full p-2"
              >
                {TICKERS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-3">
              <button
                onClick={compareProfiles}
                className="w-full rounded-md bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-500"
              >
                Compare profiles
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm">
              <span>Price feed down</span>
              <input
                type="checkbox"
                checked={feedDown}
                onChange={(event) => setFeedDown(event.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm">
              <span>Force conflicting signals</span>
              <input
                type="checkbox"
                checked={conflict}
                onChange={(event) => setConflict(event.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm">
              <span>Missing filing</span>
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                SBIN demo
              </span>
            </label>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-6">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">
                  Market signals
                </h2>
                <span className="text-xs text-slate-400">Ticker: {ticker}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="pb-3 pr-3">Agent</th>
                      <th className="pb-3 pr-3">Label</th>
                      <th className="pb-3 pr-3">Confidence</th>
                      <th className="pb-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis?.agents?.map((agent: any) => (
                      <tr
                        key={agent.agent}
                        className="border-t border-slate-800"
                      >
                        <td className="py-3 pr-3 text-slate-100">
                          {agent.agent.replace("Agent", "")}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`inline-flex rounded-full border px-2 py-1 text-xs ${labelColors[agent.label] ?? "bg-slate-500/20 text-slate-200 border-slate-500/40"}`}
                          >
                            {agent.label}
                          </span>
                        </td>
                        <td className="py-3 pr-3">
                          {formatNumber(agent.confidence)}
                        </td>
                        <td className="py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-1 text-xs ${labelColors[agent.status] ?? "bg-slate-500/20 text-slate-200"}`}
                          >
                            {agent.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">
                Synthesis
              </h2>
              {analysis?.synthesis ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${labelColors[analysis.synthesis.overallStance] ?? "bg-slate-500/20 border-slate-500/40 text-slate-200"}`}
                    >
                      {analysis.synthesis.overallStance}
                    </span>
                    <span className="text-sm text-slate-300">
                      Confidence {formatNumber(analysis.synthesis.confidence)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-300">
                    {analysis.synthesis.personalizedNote}
                  </p>
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
                      Reasoning chain
                    </p>
                    <ul className="space-y-2 text-sm text-slate-200">
                      {analysis.synthesis.reasoning.map(
                        (line: string, index: number) => (
                          <li
                            key={index}
                            className="rounded border border-slate-800 bg-slate-800/60 p-2"
                          >
                            {line}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
                      Citations
                    </p>
                    <div className="space-y-2">
                      {analysis.synthesis.citations?.map(
                        (citation: any, index: number) => (
                          <button
                            key={`${citation.docId ?? citation.dataRef}-${index}`}
                            className="w-full rounded border border-slate-700 bg-slate-800/70 p-2 text-left text-sm text-slate-200"
                          >
                            <div className="font-medium text-cyan-300">
                              {citation.docId ?? citation.dataRef}
                            </div>
                            <div className="mt-1 text-slate-300">
                              {citation.snippet}
                            </div>
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">
                    {analysis.synthesis.disclaimer}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  Waiting for analysis...
                </p>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">
                Portfolio & watchlist
              </h2>
              <div className="space-y-3">
                {profileData?.holdings &&
                  Object.entries(profileData.holdings).map(
                    ([stock, weight]: [string, any]) => (
                      <div
                        key={stock}
                        className="rounded border border-slate-800 bg-slate-800/70 p-2"
                      >
                        <div className="mb-1 flex items-center justify-between text-sm text-slate-200">
                          <span>{stock}</span>
                          <span>{Number(weight * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-2 rounded bg-slate-700">
                          <div
                            className="h-2 rounded bg-cyan-500"
                            style={{
                              width: `${Math.max(6, Number(weight * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ),
                  )}
              </div>
              <div className="mt-4 text-sm text-slate-300">
                <div className="flex justify-between">
                  <span>Risk limit</span>
                  <span>{profileData?.riskLimit ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>HHI</span>
                  <span>
                    {formatNumber(
                      (metrics?.concentration?.hhi ?? profileData?.holdings)
                        ? Object.values(profileData.holdings).reduce(
                            (sum: number, value: number) => sum + value * value,
                            0,
                          )
                        : 0,
                    )}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">Metrics</h2>
              {metrics ? (
                <div className="space-y-3 text-sm text-slate-300">
                  <div className="rounded border border-slate-800 bg-slate-800/70 p-2">
                    <div className="mb-2 font-medium text-slate-100">
                      Accuracy
                    </div>
                    {Object.entries(metrics.signalAccuracy || {}).map(
                      ([key, value]) => (
                        <div key={key} className="flex justify-between py-1">
                          <span>{key}</span>
                          <span>{Number(value).toFixed(1)}%</span>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-800/70 p-2">
                    <div className="mb-2 font-medium text-slate-100">
                      Latency
                    </div>
                    {Object.entries(metrics.signalAccuracy || {}).length && (
                      <div className="flex justify-between py-1">
                        <span>End-to-end</span>
                        <span>{metrics.latency?.endToEndMs ?? 0} ms</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p>Loading metrics...</p>
              )}
            </div>
          </div>
        </section>

        {compareData.length > 0 && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <h2 className="mb-3 text-lg font-semibold text-white">
              Compare profiles
            </h2>
            <div className="grid gap-3 md:grid-cols-3">
              {compareData.map((entry) => (
                <div
                  key={entry.profile}
                  className="rounded border border-slate-800 bg-slate-800/70 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-medium text-slate-100">
                      {entry.profile}
                    </span>
                    <span
                      className={`inline-flex rounded-full border px-2 py-1 text-xs ${labelColors[entry.synthesis.overallStance] ?? "bg-slate-500/20 text-slate-200 border-slate-500/40"}`}
                    >
                      {entry.synthesis.overallStance}
                    </span>
                  </div>
                  <p className="text-sm text-slate-300">
                    {entry.synthesis.personalizedNote}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
