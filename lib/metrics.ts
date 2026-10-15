// Metrics: point-in-time backtest hit rates, latency from session logs, and
// portfolio concentration. Session logs live in data/sessions.json.
import fs from "fs";
import { z } from "zod";
import { direction, evaluateAgent, lexiconPolarity, type AgentResult } from "./agents";
import {
  AGENT_NAMES,
  PROFILE_NAMES,
  SESSIONS_FILE,
  TICKERS,
  getDates,
  getHeadlines,
  getProfiles,
  getSeries,
  type AgentName,
  type ProfileName,
  type Ticker,
} from "./data";
import { synthesize } from "./synthesis";

export const HORIZON = 30; // trading days
const FIRST_AS_OF = 50; // MA50 needs 50 bars
const MAX_SESSIONS = 1000;

const HitSchema = z.object({
  hitRate: z.number().min(0).max(1).nullable(),
  hits: z.number().int(),
  calls: z.number().int(),
  coverage: z.number().min(0).max(1),
});
const StatSchema = z.object({ p50: z.number(), max: z.number() });

export const MetricsSchema = z.object({
  profile: z.enum(PROFILE_NAMES),
  backtest: z.object({
    horizonDays: z.number(),
    samples: z.number(),
    from: z.string(),
    to: z.string(),
    baseRateUp: z.number(),
    rows: z.record(HitSchema),
  }),
  latency: z.object({ runs: z.number(), agents: z.record(StatSchema), endToEnd: StatSchema }),
  concentration: z.object({
    hhi: z.number(),
    effectiveHoldings: z.number(),
    topHolding: z.object({ ticker: z.string(), weight: z.number() }),
    maxPositionWeight: z.number(),
    breaches: z.array(z.string()),
  }),
  lexicon: z.object({ agreement: z.number(), headlines: z.number() }),
});
export type Metrics = z.infer<typeof MetricsSchema>;

// ---------------------------------------------------------------------------
// Backtest: for each ticker and each as-of day t, run the agents on data up to t
// only, then compare the call's direction with the sign of the 30-day forward return.
// ---------------------------------------------------------------------------

type GridRow = { ticker: Ticker; asOf: number; fwd: number; agents: AgentResult[] };
let grid: GridRow[] | null = null;
const backtestCache = new Map<ProfileName, Metrics["backtest"]>();

function agentGrid() {
  if (grid) return grid;
  grid = [];
  for (const ticker of TICKERS) {
    const closes = getSeries(ticker).map((b) => b.close);
    for (let asOf = FIRST_AS_OF; asOf + HORIZON < closes.length; asOf++) {
      const ctx = { ticker, asOf, feedDown: false };
      grid.push({
        ticker,
        asOf,
        fwd: closes[asOf + HORIZON] / closes[asOf] - 1,
        agents: AGENT_NAMES.map((agent) => evaluateAgent(agent, ctx)),
      });
    }
  }
  return grid;
}

export function backtest(profileName: ProfileName): Metrics["backtest"] {
  const cached = backtestCache.get(profileName);
  if (cached) return cached;

  const rows = agentGrid();
  const keys = [...AGENT_NAMES, "Synthesis"] as const;
  const tally = Object.fromEntries(keys.map((k) => [k, { hits: 0, calls: 0 }])) as Record<(typeof keys)[number], { hits: number; calls: number }>;
  const score = (key: (typeof keys)[number], call: number, actual: number) => {
    if (call === 0) return; // Neutral / Normal / No-evidence are not calls
    tally[key].calls++;
    if (call === actual) tally[key].hits++;
  };

  let ups = 0;
  for (const row of rows) {
    const actual = Math.sign(row.fwd);
    if (actual > 0) ups++;
    for (const a of row.agents) score(a.agent, direction(a.label), actual);
    const s = synthesize({ ticker: row.ticker, profileName, agents: row.agents, asOf: row.asOf });
    score("Synthesis", s.stance === "Bullish" ? 1 : s.stance === "Bearish" ? -1 : 0, actual);
  }

  const dates = getDates();
  const result = {
    horizonDays: HORIZON,
    samples: rows.length,
    from: dates[FIRST_AS_OF],
    to: dates[dates.length - 1 - HORIZON],
    baseRateUp: round3(ups / (rows.length || 1)),
    rows: Object.fromEntries(
      keys.map((k) => [
        k,
        {
          hitRate: tally[k].calls ? round3(tally[k].hits / tally[k].calls) : null,
          hits: tally[k].hits,
          calls: tally[k].calls,
          coverage: round3(tally[k].calls / (rows.length || 1)),
        },
      ]),
    ),
  };
  backtestCache.set(profileName, result);
  return result;
}

// ---------------------------------------------------------------------------
// Session logging and latency
// ---------------------------------------------------------------------------

export type SessionEntry = {
  id: string;
  sessionId: string;
  ts: string;
  ticker: Ticker;
  profile: ProfileName;
  feedDown: boolean;
  conflict: boolean;
  stance: string;
  rawStance: string;
  confidence: number;
  conflicts: number;
  degraded: AgentName[];
  narrator: "llm" | "template";
  latency: Partial<Record<AgentName | "endToEnd", number>>;
};

function readSessions(): SessionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) as { sessions?: SessionEntry[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

/** Appends one analysis run. Sync read+write keeps concurrent requests in one process from interleaving. */
export function logSession(entry: SessionEntry) {
  try {
    const sessions = [...readSessions(), entry].slice(-MAX_SESSIONS);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions }, null, 2) + "\n");
  } catch (err) {
    console.warn("[metrics] could not write sessions.json:", err);
  }
}

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const stat = (xs: number[]) => ({ p50: round3(percentile(xs, 0.5)), max: round3(xs.length ? Math.max(...xs) : 0) });

export function latencyStats(): Metrics["latency"] {
  const runs = readSessions().slice(-500);
  const series = (key: AgentName | "endToEnd") =>
    runs.map((r) => r.latency?.[key]).filter((x): x is number => typeof x === "number");
  return {
    runs: runs.length,
    agents: Object.fromEntries(AGENT_NAMES.map((a) => [a, stat(series(a))])),
    endToEnd: stat(series("endToEnd")),
  };
}

// ---------------------------------------------------------------------------
// Concentration and lexicon sanity check
// ---------------------------------------------------------------------------

export function concentration(profileName: ProfileName): Metrics["concentration"] {
  const profile = getProfiles()[profileName];
  const entries = Object.entries(profile.holdings) as [Ticker, number][];
  const hhi = entries.reduce((s, [, w]) => s + w * w, 0);
  const [topTicker, topWeight] = entries.reduce((best, e) => (e[1] > best[1] ? e : best), ["-" as Ticker, 0]);
  return {
    hhi: round3(hhi),
    effectiveHoldings: round3(hhi ? 1 / hhi : 0),
    topHolding: { ticker: topTicker, weight: topWeight },
    maxPositionWeight: profile.maxPositionWeight,
    breaches: entries.filter(([, w]) => w > profile.maxPositionWeight).map(([t]) => t),
  };
}

/** How often the sentiment lexicon agrees with the seeded polarity hints. */
export function lexiconCheck(): Metrics["lexicon"] {
  const headlines = TICKERS.flatMap((t) => getHeadlines(t));
  const agree = headlines.filter((h) => lexiconPolarity(h.title) === h.polarityHint).length;
  return { agreement: round3(agree / (headlines.length || 1)), headlines: headlines.length };
}

export function getMetrics(profileName: ProfileName): Metrics {
  return MetricsSchema.parse({
    profile: profileName,
    backtest: backtest(profileName),
    latency: latencyStats(),
    concentration: concentration(profileName),
    lexicon: lexiconCheck(),
  });
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
