"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AgentResult } from "@/lib/agents";
import type { AgentName, Profile, ProfileName, Ticker } from "@/lib/data";
import type { Metrics } from "@/lib/metrics";
import type { Synthesis } from "@/lib/synthesis";

type ProfilesResponse = {
  profiles: Record<ProfileName, Profile>;
  tickers: { ticker: Ticker; name: string }[];
  dataset: { synthetic: boolean; seed: number; bars: number; from: string; to: string };
  narrator: "llm" | "template";
};
type AnalyzeResponse = {
  ticker: Ticker;
  profile: ProfileName;
  flags: { feedDown: boolean; conflict: boolean; missingFiling: boolean };
  asOf: string;
  agents: AgentResult[];
  synthesis: Synthesis;
  latency: { perAgentMs: Record<string, number>; endToEndMs: number };
  prices: { date: string; close: number }[] | null;
};

const PROFILE_ORDER: ProfileName[] = ["Conservative", "Moderate", "Aggressive"];
const AGENT_LABEL: Record<AgentName, string> = {
  MomentumAgent: "Momentum",
  VolumeAnomalyAgent: "Volume anomaly",
  SentimentAgent: "Sentiment",
  FilingsRAGAgent: "Filings RAG",
};
const AGENT_METHOD: Record<AgentName, string> = {
  MomentumAgent: "MA20/MA50 crossover + RSI14",
  VolumeAnomalyAgent: "Volume z-score vs 20-day mean",
  SentimentAgent: "Headline lexicon, last 30 sessions",
  FilingsRAGAgent: "BM25 retrieval over /data/docs",
};
const BULL = new Set(["Bullish", "Accumulation", "Positive", "Supportive"]);
const BEAR = new Set(["Bearish", "Distribution", "Negative", "Cautionary"]);

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const isOn = (v: string | null) => v === "1" || v === "true";

function getSessionId() {
  try {
    let id = sessionStorage.getItem("vf-session");
    if (!id) {
      id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      sessionStorage.setItem("vf-session", id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink2">{title}</h2>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** Polarity pill: the icon carries the color, the text stays in ink. */
function SignalPill({ label, large = false }: { label: string; large?: boolean }) {
  const [icon, tone] = BULL.has(label)
    ? ["▲", "border-bull/60 bg-bull/10 [&>i]:text-bull"]
    : BEAR.has(label)
      ? ["▼", "border-bear/60 bg-bear/10 [&>i]:text-bear"]
      : label === "No-evidence" || label === "Insufficient evidence"
        ? ["∅", "border-dashed border-muted/60 [&>i]:text-muted"]
        : ["●", "border-axis bg-axis/40 [&>i]:text-muted"];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border ${large ? "px-3 py-1 text-base font-semibold" : "px-2 py-0.5 text-xs"} text-ink ${tone}`}>
      <i className="not-italic" aria-hidden>
        {icon}
      </i>
      {label}
    </span>
  );
}

function StatusBadge({ status, forced }: { status: "ok" | "degraded"; forced?: boolean }) {
  return status === "ok" ? (
    <span className="inline-flex items-center gap-1 text-xs text-ink2">
      <span className="text-good" aria-hidden>
        ✓
      </span>
      ok
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-xs font-medium text-ink">
      <span className="text-warn" aria-hidden>
        ⚠
      </span>
      {forced ? "degraded · forced" : "degraded"}
    </span>
  );
}

function Meter({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-grid" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-1.5 rounded-full bg-ink2" style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-ink2">{pct(value)}</span>
    </div>
  );
}

function Toggle({ label, hint, on, onClick }: { label: string; hint: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${on ? "border-warn/60 bg-warn/10" : "border-white/10 bg-raised hover:border-white/20"}`}
    >
      <span>
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-warn" : "bg-axis"}`} aria-hidden>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

function CiteChips({ ids }: { ids: string[] }) {
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <a key={id} href={`#cite-${id}`} className="rounded bg-axis px-1 font-mono text-[10px] text-ink2 hover:bg-bull/30 hover:text-ink">
          {id}
        </a>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Charts (single series each; hover layer on the sparkline, tooltips on bars)
// ---------------------------------------------------------------------------

function Sparkline({ points, ticker }: { points: { date: string; close: number }[]; ticker: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 140;
  const PAD = 6;
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - min) / (max - min || 1)) * (H - 2 * PAD);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join("");
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(((rel - PAD) / (W - 2 * PAD)) * (points.length - 1)))));
  };
  const h = hover !== null ? points[hover] : null;
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 text-xs text-muted">
        <span>
          Last <span className="tabular-nums text-ink">{last.close.toFixed(2)}</span>
        </span>
        <span>
          High <span className="tabular-nums text-ink2">{max.toFixed(2)}</span>
        </span>
        <span>
          Low <span className="tabular-nums text-ink2">{min.toFixed(2)}</span>
        </span>
        <span>{points.length} sessions</span>
      </div>
      <div className="relative h-36 w-full cursor-crosshair" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label={`${ticker} closing price, ${points.length} sessions from ${first.date} to ${last.date}, low ${min.toFixed(2)}, high ${max.toFixed(2)}`}>
          <line x1={0} x2={W} y1={y(max)} y2={y(max)} stroke="#2c2c2a" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={y(min)} y2={y(min)} stroke="#2c2c2a" vectorEffect="non-scaling-stroke" />
          <path d={path} fill="none" stroke="#c3c2b7" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {h && hover !== null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-muted/60" style={{ left: `${(x(hover) / W) * 100}%` }} />
            <div
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-ink"
              style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(h.close) / H) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-raised px-2 py-1 text-xs shadow-lg"
              style={{ left: `${Math.min(85, Math.max(15, (x(hover) / W) * 100))}%` }}
            >
              <span className="text-muted">{h.date}</span> <span className="tabular-nums text-ink">{h.close.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{first.date}</span>
        <span>{last.date}</span>
      </div>
    </div>
  );
}

function HitRateBars({ bt }: { bt: Metrics["backtest"] }) {
  const rows: [string, string][] = [
    ["MomentumAgent", "Momentum"],
    ["VolumeAnomalyAgent", "Volume"],
    ["SentimentAgent", "Sentiment"],
    ["FilingsRAGAgent", "Filings RAG"],
    ["Synthesis", "Synthesis"],
  ];
  return (
    <div className="space-y-2">
      {rows.map(([key, label]) => {
        const r = bt.rows[key];
        const delta = r?.hitRate !== null && r ? r.hitRate - bt.baseRateUp : null;
        return (
          <div key={key} className={key === "Synthesis" ? "border-t border-white/10 pt-2" : ""}>
            <div className="mb-1 flex justify-between text-xs">
              <span className={key === "Synthesis" ? "font-semibold text-ink" : "text-ink2"}>{label}</span>
              <span className="tabular-nums text-ink2">
                {r?.hitRate === null || !r ? "no calls" : `${pct(r.hitRate)} of ${r.calls} calls`}
                {delta !== null && <span className="ml-1 text-muted">({delta >= 0 ? "+" : ""}{(delta * 100).toFixed(0)} pts)</span>}
              </span>
            </div>
            <div
              className="relative h-3 rounded-r bg-grid"
              title={r ? `${label}: ${r.hits}/${r.calls} directional calls correct; coverage ${pct(r.coverage)} of ${bt.samples} samples` : label}
            >
              {r?.hitRate !== null && r && <div className="h-3 rounded-r bg-ink2" style={{ width: `${r.hitRate * 100}%` }} />}
              <div className="absolute -top-0.5 h-4 border-l-2 border-dashed border-warn" style={{ left: `${bt.baseRateUp * 100}%` }} aria-hidden />
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-xs text-muted">
        <span className="mr-1 inline-block h-3 border-l-2 border-dashed border-warn align-middle" aria-hidden />
        Base rate: an &ldquo;always up&rdquo; call is right {pct(bt.baseRateUp)} of the time. Point-in-time backtest, {bt.samples} samples
        ({bt.from} to {bt.to}), {bt.horizonDays}-day forward returns. Neutral and No-evidence are not counted as calls.
      </p>
    </div>
  );
}

function HoldingsBars({ profile, focus, onPick }: { profile: Profile; focus: Ticker; onPick: (t: Ticker) => void }) {
  const entries = (Object.entries(profile.holdings) as [Ticker, number][]).sort((a, b) => b[1] - a[1]);
  const scale = Math.max(profile.maxPositionWeight * 1.25, ...entries.map(([, w]) => w)) || 1;
  return (
    <div className="space-y-2">
      {entries.map(([t, w]) => {
        const over = w > profile.maxPositionWeight;
        return (
          <button key={t} type="button" onClick={() => onPick(t)} className={`block w-full rounded px-1 py-0.5 text-left hover:bg-raised ${t === focus ? "bg-raised" : ""}`}>
            <div className="mb-1 flex justify-between text-xs">
              <span className={t === focus ? "font-semibold text-ink" : "text-ink2"}>{t}</span>
              <span className="tabular-nums text-ink2">
                {over && (
                  <span className="mr-1.5">
                    <span className="text-serious" aria-hidden>
                      ⚠
                    </span>{" "}
                    over cap
                  </span>
                )}
                {pct(w)}
              </span>
            </div>
            <div className="relative h-2.5 rounded-r bg-grid" title={`${t}: ${pct(w)} of portfolio, cap ${pct(profile.maxPositionWeight)}`}>
              <div className={`h-2.5 rounded-r ${over ? "bg-serious" : "bg-ink2"}`} style={{ width: `${(w / scale) * 100}%` }} />
              <div className="absolute -top-0.5 h-3.5 border-l-2 border-dashed border-muted" style={{ left: `${(profile.maxPositionWeight / scale) * 100}%` }} aria-hidden />
            </div>
          </button>
        );
      })}
      <p className="text-xs text-muted">
        <span className="mr-1 inline-block h-3 border-l-2 border-dashed border-muted align-middle" aria-hidden />
        Position cap {pct(profile.maxPositionWeight)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [meta, setMeta] = useState<ProfilesResponse | null>(null);
  const [profile, setProfile] = useState<ProfileName>("Moderate");
  const [ticker, setTicker] = useState<Ticker>("RELIANCE");
  const [feedDown, setFeedDown] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [compare, setCompare] = useState<{ key: string; rows: AnalyzeResponse[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastNonSbin = useRef<Ticker>("RELIANCE");
  const requestId = useRef(0);
  const sessionId = useRef("anonymous");

  // Load profiles, then apply ?ticker=&profile=&feedDown=&conflict= from the URL.
  useEffect(() => {
    sessionId.current = getSessionId();
    fetch("/api/profiles")
      .then((r) => {
        if (!r.ok) throw new Error(`profiles failed (${r.status})`);
        return r.json() as Promise<ProfilesResponse>;
      })
      .then((data) => {
        const q = new URLSearchParams(window.location.search);
        const t = q.get("ticker");
        const p = q.get("profile");
        if (t && data.tickers.some((x) => x.ticker === t)) setTicker(t as Ticker);
        if (p && p in data.profiles) setProfile(p as ProfileName);
        setFeedDown(isOn(q.get("feedDown")));
        setConflict(isOn(q.get("conflict")));
        setMeta(data);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Keep the URL shareable.
  useEffect(() => {
    if (!meta) return;
    const q = new URLSearchParams({ ticker, profile });
    if (feedDown) q.set("feedDown", "1");
    if (conflict) q.set("conflict", "1");
    window.history.replaceState(null, "", `?${q}`);
  }, [meta, ticker, profile, feedDown, conflict]);

  const analyzeUrl = useCallback(
    (p: ProfileName, extra = "") =>
      `/api/analyze?ticker=${ticker}&profile=${p}&feedDown=${feedDown ? 1 : 0}&conflict=${conflict ? 1 : 0}&session=${encodeURIComponent(sessionId.current)}${extra}`,
    [ticker, feedDown, conflict],
  );

  useEffect(() => {
    if (!meta) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetch(analyzeUrl(profile))
      .then((r) => {
        if (!r.ok) throw new Error(`analysis failed (${r.status})`);
        return r.json() as Promise<AnalyzeResponse>;
      })
      .then(async (data) => {
        if (id !== requestId.current) return;
        setAnalysis(data);
        const m = await fetch(`/api/metrics?profile=${profile}`);
        if (m.ok && id === requestId.current) setMetrics((await m.json()) as Metrics);
      })
      .catch((e: Error) => id === requestId.current && setError(e.message))
      .finally(() => id === requestId.current && setLoading(false));
  }, [meta, profile, analyzeUrl]);

  const compareKey = `${ticker}|${feedDown}|${conflict}`;
  const runCompare = async () => {
    setComparing(true);
    try {
      const rows = await Promise.all(
        PROFILE_ORDER.map((p) =>
          fetch(analyzeUrl(p, "&narrate=0")).then((r) => {
            if (!r.ok) throw new Error(`compare failed (${r.status})`);
            return r.json() as Promise<AnalyzeResponse>;
          }),
        ),
      );
      setCompare({ key: compareKey, rows });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setComparing(false);
    }
  };
  const compareRows = compare?.key === compareKey ? compare.rows : null;

  const toggleMissingFiling = () => {
    if (ticker === "SBIN") setTicker(lastNonSbin.current);
    else {
      lastNonSbin.current = ticker;
      setTicker("SBIN");
    }
  };

  const prof = meta?.profiles[profile];
  const syn = analysis?.synthesis;
  const companyName = meta?.tickers.find((t) => t.ticker === ticker)?.name ?? ticker;

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
      {/* Disclosure */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-ink2">
        <span className="font-semibold text-ink">
          <span className="text-warn" aria-hidden>
            ⓘ
          </span>{" "}
          Synthetic data
        </span>
        <span>
          All prices, headlines and filings are generated (seed {meta?.dataset.seed ?? 42}
          {meta ? `, ${meta.dataset.bars} sessions ${meta.dataset.from} to ${meta.dataset.to}` : ""}). No market APIs are called.
        </span>
        <span className="font-medium text-ink">Educational only, not investment advice.</span>
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-muted">PS 04 · Hackathon demo</p>
          <h1 className="text-3xl font-bold tracking-tight text-ink">V-Finance</h1>
          <p className="text-sm text-ink2">Four independent agents, one cited and profile-aware synthesis.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-white/10 bg-raised px-2.5 py-1 text-ink2">
            Narrative: {meta?.narrator === "llm" ? "Claude (citations re-validated)" : "deterministic template"}
          </span>
          <span className="rounded-full border border-white/10 bg-raised px-2.5 py-1 text-ink2">No database · JSON on disk</span>
        </div>
      </header>

      {/* Controls */}
      <section className="grid gap-4 rounded-xl border border-white/10 bg-surface p-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Profile</div>
            <div className="inline-flex rounded-lg border border-white/10 bg-raised p-0.5" role="radiogroup" aria-label="Investor profile">
              {PROFILE_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={p === profile}
                  onClick={() => setProfile(p)}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${p === profile ? "bg-ink font-semibold text-plane" : "text-ink2 hover:text-ink"}`}
                >
                  {p}
                </button>
              ))}
            </div>
            {prof && <p className="mt-1.5 text-xs text-muted">{prof.description}</p>}
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Ticker (NSE, synthetic)</div>
            <div className="flex flex-wrap gap-1.5">
              {(meta?.tickers ?? []).map(({ ticker: t, name }) => (
                <button
                  key={t}
                  type="button"
                  title={name}
                  onClick={() => setTicker(t)}
                  aria-pressed={t === ticker}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs transition ${t === ticker ? "border-ink bg-ink text-plane" : "border-white/10 bg-raised text-ink2 hover:border-white/30"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={runCompare}
            disabled={!meta || comparing}
            className="rounded-lg bg-bull px-4 py-2 text-sm font-semibold text-white transition hover:bg-bull/85 disabled:opacity-50"
          >
            {comparing ? "Comparing…" : `Compare all 3 profiles on ${ticker}`}
          </button>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">Degraded-data toggles</div>
          <Toggle label="Price feed down" hint="Momentum + Volume lose their data (feedDown=1)" on={feedDown} onClick={() => setFeedDown((v) => !v)} />
          <Toggle label="Missing filing" hint="Switches to SBIN, which has no docs in the corpus" on={ticker === "SBIN"} onClick={toggleMissingFiling} />
          <Toggle label="Force conflicting signals" hint="Splits agents into opposing camps (conflict=1)" on={conflict} onClick={() => setConflict((v) => !v)} />
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-lg border border-critical/60 bg-critical/10 px-3 py-2 text-sm text-ink">
          <span className="text-critical" aria-hidden>
            ✕
          </span>{" "}
          {error}
        </div>
      )}

      <div className={`grid gap-4 lg:grid-cols-[1.6fr_1fr] ${loading ? "opacity-70 transition-opacity" : ""}`}>
        <div className="min-w-0 space-y-4">
          {/* Price */}
          <Panel title={`${ticker} · ${companyName}`} aside={analysis ? `as of ${analysis.asOf}` : undefined}>
            {analysis?.prices ? (
              <Sparkline points={analysis.prices} ticker={ticker} />
            ) : analysis ? (
              <div className="flex h-36 items-center justify-center rounded-lg border border-dashed border-warn/50 text-sm text-ink2">
                <span className="text-warn" aria-hidden>
                  ⚠
                </span>
                &nbsp;Price feed down: no bars to chart
              </div>
            ) : (
              <div className="h-36 animate-pulse rounded-lg bg-raised" />
            )}
          </Panel>

          {/* Signals */}
          <Panel title="Agent signals" aside={analysis ? `run in parallel · ${analysis.latency.endToEndMs.toFixed(1)} ms end-to-end` : undefined}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-white/10">
                    <th className="pb-2 pr-3 font-medium">Agent</th>
                    <th className="pb-2 pr-3 font-medium">Signal</th>
                    <th className="pb-2 pr-3 font-medium">Confidence</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {(analysis?.agents ?? []).map((a) => (
                    <tr key={a.agent} className="border-b border-white/5 align-top last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-ink">{AGENT_LABEL[a.agent]}</div>
                        <div className="text-xs text-muted">{AGENT_METHOD[a.agent]}</div>
                        <div className="mt-1 max-w-md text-xs leading-relaxed text-ink2">{a.reasoning}</div>
                        {a.citations.length > 0 && (
                          <div className="mt-1 text-[11px] text-muted">
                            cites {[...new Set(a.citations.map((c) => c.ref))].join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <SignalPill label={a.label} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <Meter value={a.confidence} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <StatusBadge status={a.status} forced={a.reasoning.startsWith("[Stress test]")} />
                      </td>
                      <td className="whitespace-nowrap py-2.5 text-right text-xs tabular-nums text-ink2">{a.latencyMs.toFixed(2)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Synthesis */}
          <Panel title={`Synthesis · ${profile}`} aside={syn ? `${syn.evidenceAgents}/4 agents with evidence` : undefined}>
            {syn ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <SignalPill label={syn.stance} large />
                  <div className="text-sm text-ink2">
                    confidence <span className="font-semibold tabular-nums text-ink">{pct(syn.confidence)}</span> · net score{" "}
                    <span className="tabular-nums text-ink">{syn.score >= 0 ? "+" : ""}{syn.score.toFixed(2)}</span>
                  </div>
                  {syn.stance !== syn.rawStance && (
                    <span className="rounded border border-serious/50 bg-serious/10 px-2 py-0.5 text-xs text-ink">
                      <span className="text-serious" aria-hidden>
                        ⚠
                      </span>{" "}
                      signals said {syn.rawStance}; {profile} risk limits applied
                    </span>
                  )}
                </div>

                {syn.conflicts.length > 0 && (
                  <div className="rounded-lg border border-warn/50 bg-warn/5 p-3 text-sm">
                    <div className="mb-1 font-semibold text-ink">
                      <span className="text-warn" aria-hidden>
                        ⚠
                      </span>{" "}
                      Conflicting signals
                    </div>
                    <ul className="list-disc space-y-1 pl-5 text-ink2">
                      {syn.conflicts.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                    Narrative · {syn.narrative.mode === "llm" ? `Claude (${syn.narrative.model})` : "template"}
                  </div>
                  {syn.narrative.sentences.length ? (
                    <p className="text-sm leading-relaxed text-ink">
                      {syn.narrative.sentences.map((s, i) => (
                        <span key={i}>
                          {s.text}
                          <CiteChips ids={s.citations} />{" "}
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className="text-sm italic text-muted">Insufficient evidence: no citable statements to narrate.</p>
                  )}
                  {syn.narrative.note && <p className="mt-1 text-xs text-muted">{syn.narrative.note}</p>}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {syn.riskChecks.map((rc) => (
                    <div key={rc.check} className="rounded-lg border border-white/10 bg-raised p-2.5 text-xs">
                      <div className="mb-0.5 font-semibold capitalize text-ink">
                        <span className={rc.status === "pass" ? "text-good" : rc.status === "flag" ? "text-serious" : "text-warn"} aria-hidden>
                          {rc.status === "pass" ? "✓" : rc.status === "flag" ? "⚠" : "?"}
                        </span>{" "}
                        {rc.check} · {rc.status}
                      </div>
                      <div className="text-ink2">
                        {rc.detail}
                        <CiteChips ids={rc.citations} />
                      </div>
                    </div>
                  ))}
                </div>

                <details className="group" open>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted">Reasoning chain ({syn.reasoning.length} steps)</summary>
                  <ol className="mt-2 space-y-1.5">
                    {syn.reasoning.map((step, i) => (
                      <li
                        key={i}
                        className={`rounded border px-2.5 py-1.5 text-xs leading-relaxed ${step.kind === "insufficient" ? "border-dashed border-muted/40 italic text-muted" : "border-white/5 bg-raised text-ink2"}`}
                      >
                        <span className="mr-1.5 font-mono text-[10px] uppercase text-muted">{step.kind === "insufficient" ? "insufficient evidence" : step.kind}</span>
                        {step.text}
                        {step.citations.length > 0 && <CiteChips ids={step.citations} />}
                      </li>
                    ))}
                  </ol>
                </details>

                <details>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted">Citations ({syn.citations.length})</summary>
                  <ul className="mt-2 space-y-1">
                    {syn.citations.map((c) => (
                      <li key={c.id} id={`cite-${c.id}`} className="scroll-mt-4 rounded border border-white/5 bg-raised px-2.5 py-1.5 text-xs target:border-bull target:ring-1 target:ring-bull">
                        <span className="mr-2 font-mono text-ink">{c.id}</span>
                        <span className="mr-2 rounded bg-axis px-1 text-[10px] uppercase text-ink2">{c.kind}</span>
                        <span className="mr-2 font-mono text-muted">
                          {c.ref}
                          {c.date ? ` · ${c.date}` : ""}
                        </span>
                        <span className="text-ink2">{c.snippet}</span>
                      </li>
                    ))}
                  </ul>
                </details>

                <p className="border-t border-white/10 pt-3 text-xs text-muted">{syn.disclaimer}</p>
              </div>
            ) : (
              <div className="h-40 animate-pulse rounded-lg bg-raised" />
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          {/* Portfolio */}
          <Panel title="Portfolio & watchlist" aside={profile}>
            {prof && metrics ? (
              <div className="space-y-4">
                <HoldingsBars profile={prof} focus={ticker} onPick={setTicker} />
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-raised p-2">
                    <dt className="text-[10px] uppercase text-muted">HHI</dt>
                    <dd className="text-lg font-semibold text-ink">{metrics.concentration.hhi.toFixed(3)}</dd>
                  </div>
                  <div className="rounded-lg bg-raised p-2">
                    <dt className="text-[10px] uppercase text-muted">Effective N</dt>
                    <dd className="text-lg font-semibold text-ink">{metrics.concentration.effectiveHoldings.toFixed(1)}</dd>
                  </div>
                  <div className="rounded-lg bg-raised p-2">
                    <dt className="text-[10px] uppercase text-muted">Top holding</dt>
                    <dd className="text-lg font-semibold text-ink">{pct(metrics.concentration.topHolding.weight)}</dd>
                    <dd className="text-[10px] text-muted">{metrics.concentration.topHolding.ticker}</dd>
                  </div>
                </dl>
                <div>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Watchlist</div>
                  <div className="flex flex-wrap gap-1.5">
                    {prof.watchlist.map((t) => (
                      <button key={t} type="button" onClick={() => setTicker(t)} className="rounded border border-white/10 bg-raised px-2 py-0.5 font-mono text-xs text-ink2 hover:border-white/30">
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted">
                  Risk settings: volatility cap {prof.maxVolatility === null ? "none" : pct(prof.maxVolatility)}, stance threshold ±{prof.stanceThreshold}.
                </p>
              </div>
            ) : (
              <div className="h-40 animate-pulse rounded-lg bg-raised" />
            )}
          </Panel>

          {/* Metrics */}
          <Panel title="Metrics" aside={metrics ? `${metrics.latency.runs} logged runs` : undefined}>
            {metrics ? (
              <div className="space-y-5">
                <div>
                  <div className="mb-2 text-xs font-semibold text-ink">Hit rate vs 30-day forward return</div>
                  <HitRateBars bt={metrics.backtest} />
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold text-ink">Latency (logged runs)</div>
                  <table className="w-full text-xs">
                    <thead className="text-muted">
                      <tr>
                        <th className="pb-1 text-left font-medium">Stage</th>
                        <th className="pb-1 text-right font-medium">p50</th>
                        <th className="pb-1 text-right font-medium">max</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums text-ink2">
                      {(Object.keys(AGENT_LABEL) as AgentName[]).map((a) => (
                        <tr key={a}>
                          <td className="py-0.5">{AGENT_LABEL[a]}</td>
                          <td className="py-0.5 text-right">{metrics.latency.agents[a]?.p50.toFixed(2)} ms</td>
                          <td className="py-0.5 text-right">{metrics.latency.agents[a]?.max.toFixed(2)} ms</td>
                        </tr>
                      ))}
                      <tr className="border-t border-white/10 font-semibold text-ink">
                        <td className="pt-1">End-to-end</td>
                        <td className="pt-1 text-right">{metrics.latency.endToEnd.p50.toFixed(2)} ms</td>
                        <td className="pt-1 text-right">{metrics.latency.endToEnd.max.toFixed(2)} ms</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted">
                  Sentiment lexicon agrees with the seeded polarity hints on {pct(metrics.lexicon.agreement)} of {metrics.lexicon.headlines} headlines.
                </p>
              </div>
            ) : (
              <div className="h-40 animate-pulse rounded-lg bg-raised" />
            )}
          </Panel>
        </div>
      </div>

      {/* Compare profiles */}
      {compareRows && (
        <Panel title={`Profile comparison · ${ticker}`} aside="same agent outputs, different weights and risk limits">
          <div className="grid gap-3 md:grid-cols-3">
            {compareRows.map((row) => (
              <div key={row.profile} className={`rounded-lg border p-3 ${row.profile === profile ? "border-ink/40 bg-raised" : "border-white/10 bg-raised/60"}`}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-ink">{row.profile}</span>
                  <SignalPill label={row.synthesis.stance} />
                </div>
                <div className="mb-2 text-xs text-ink2">
                  confidence <span className="tabular-nums text-ink">{pct(row.synthesis.confidence)}</span> · score{" "}
                  <span className="tabular-nums text-ink">{row.synthesis.score >= 0 ? "+" : ""}{row.synthesis.score.toFixed(2)}</span>
                  {row.synthesis.stance !== row.synthesis.rawStance && <> · raw {row.synthesis.rawStance}</>}
                </div>
                <ul className="space-y-1 text-xs text-ink2">
                  {row.synthesis.riskChecks.map((rc) => (
                    <li key={rc.check}>
                      <span className={rc.status === "pass" ? "text-good" : rc.status === "flag" ? "text-serious" : "text-warn"} aria-hidden>
                        {rc.status === "pass" ? "✓" : rc.status === "flag" ? "⚠" : "?"}
                      </span>{" "}
                      {rc.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <footer className="pb-6 pt-2 text-center text-xs text-muted">
        V-Finance · synthetic data, deterministic seed 42 · educational demo, not investment advice
      </footer>
    </main>
  );
}
