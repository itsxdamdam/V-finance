// Four independent signal agents. Each is an async function whose output is
// validated against AgentResultSchema. Agents never throw: failures and missing
// inputs come back as status="degraded", label="No-evidence".
import { z } from "zod";
import {
  AGENT_NAMES,
  COMPANY,
  getDates,
  getDocs,
  getHeadlines,
  getSeries,
  type AgentName,
  type Ticker,
} from "./data";

export const CitationSchema = z.object({
  ref: z.string().min(1), // docId, headline id, or a data ref such as market:TCS:close
  kind: z.enum(["market", "headline", "filing", "profile"]),
  snippet: z.string().min(1),
  date: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const LABELS = [
  "Bullish",
  "Bearish",
  "Neutral",
  "Accumulation",
  "Distribution",
  "Normal",
  "Drying-up",
  "Positive",
  "Negative",
  "Supportive",
  "Cautionary",
  "No-evidence",
] as const;
export type Label = (typeof LABELS)[number];

export const AgentResultSchema = z
  .object({
    agent: z.enum(AGENT_NAMES),
    ticker: z.string(),
    label: z.enum(LABELS),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
    citations: z.array(CitationSchema),
    latencyMs: z.number().nonnegative(),
    status: z.enum(["ok", "degraded"]),
  })
  .superRefine((r, ctx) => {
    if (r.label === "No-evidence" && r.status !== "degraded")
      ctx.addIssue({ code: "custom", message: "No-evidence results must be degraded" });
    if (r.label !== "No-evidence" && r.citations.length === 0)
      ctx.addIssue({ code: "custom", message: "A labelled result must cite its evidence" });
  });
export type AgentResult = z.infer<typeof AgentResultSchema>;

export type AgentContext = { ticker: Ticker; asOf: number; feedDown: boolean };
type Core = Pick<AgentResult, "label" | "confidence" | "reasoning" | "citations" | "status">;

/** +1 bullish, -1 bearish, 0 non-directional. */
export function direction(label: Label): -1 | 0 | 1 {
  if (["Bullish", "Accumulation", "Positive", "Supportive"].includes(label)) return 1;
  if (["Bearish", "Distribution", "Negative", "Cautionary"].includes(label)) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const num = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
const millions = (x: number) => `${(x / 1e6).toFixed(2)}M`;

const noEvidence = (reason: string): Core => ({
  label: "No-evidence",
  confidence: 0,
  reasoning: reason,
  citations: [],
  status: "degraded",
});

// Shared polarity lexicon for headlines (SentimentAgent) and filing passages (FilingsRAGAgent).
const POSITIVE = new Set(
  "strong stronger strongest strengthen robust record improved improving improve expanded expansion expands resilient healthy momentum raised raises wins win recover recovery leading grew growing stable beats beat rally rallies upgrade upgrades jumps outperform".split(" "),
);
const NEGATIVE = new Set(
  "weak weaker slowdown slowed slow slower slowly slowing slows pressure pressures risk risks cut cuts lagged headwind cautious uncertainty delayed deferred stress compression restrictions disruption elevated outflows moderated intensifies slides slump probe misses miss downgrade downgrades fall falls fell concerns plunges warns".split(" "),
);
const STOPWORDS = new Set("a an the and or of to in on at for by with from as is are was were be been it its this that than into amid after before over per".split(" "));

const tokenize = (text: string) =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));

function lexicon(text: string) {
  let pos = 0;
  let neg = 0;
  for (const token of tokenize(text)) {
    if (POSITIVE.has(token)) pos++;
    if (NEGATIVE.has(token)) neg++;
  }
  return { pos, neg };
}

export function lexiconPolarity(text: string) {
  const { pos, neg } = lexicon(text);
  return pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
}

function rsi(closes: number[], period = 14) {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period;
  loss /= period;
  // Wilder smoothing over the rest of the window.
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

const FEED_DOWN = "Price feed is down (feedDown=1): no OHLCV bars were available, so this signal was withheld rather than guessed.";

// ---------------------------------------------------------------------------
// Agent cores (pure, synchronous; also reused by the backtest in metrics.ts)
// ---------------------------------------------------------------------------

function momentum({ ticker, asOf, feedDown }: AgentContext): Core {
  if (feedDown) return noEvidence(FEED_DOWN);
  const bars = getSeries(ticker).slice(0, asOf + 1);
  if (bars.length < 50) return noEvidence(`Only ${bars.length} bars available; MA50 needs 50.`);

  const closes = bars.map((b) => b.close);
  const ma20 = mean(closes.slice(-20));
  const ma50 = mean(closes.slice(-50));
  const r = rsi(closes);
  const spread = ma20 / ma50 - 1;
  // Direction comes from the crossover (±0.5% dead band); RSI confirms or fades it.
  const label: Label = spread > 0.005 ? "Bullish" : spread < -0.005 ? "Bearish" : "Neutral";
  const rsiConfirms = (label === "Bullish" && r > 50 && r < 70) || (label === "Bearish" && r < 50 && r > 30);
  const confidence =
    label === "Neutral" ? 0.35 : clamp(0.45 + Math.abs(spread) * 4 + (rsiConfirms ? 0.1 : -0.1), 0.3, 0.9);
  const last = bars[bars.length - 1];
  const zone = r > 70 ? " (overbought)" : r < 30 ? " (oversold)" : "";

  return {
    label,
    confidence: round2(confidence),
    reasoning:
      `20-day MA ${num(ma20)} is ${spread >= 0 ? "above" : "below"} the 50-day MA ${num(ma50)} (${pct(spread)}); 14-day RSI is ${r.toFixed(1)}${zone}` +
      (label === "Neutral"
        ? ", inside the ±0.5% dead band, so no directional call."
        : rsiConfirms
          ? ", confirming the trend."
          : ", not confirming the trend, so confidence is reduced."),
    citations: [
      {
        ref: `market:${ticker}:close`,
        kind: "market",
        date: last.date,
        snippet: `MA20 ${num(ma20)} | MA50 ${num(ma50)} | RSI14 ${r.toFixed(1)} | close ${num(last.close)} on ${last.date}`,
      },
    ],
    status: "ok",
  };
}

function volumeAnomaly({ ticker, asOf, feedDown }: AgentContext): Core {
  if (feedDown) return noEvidence(FEED_DOWN);
  const bars = getSeries(ticker).slice(0, asOf + 1);
  if (bars.length < 26) return noEvidence(`Only ${bars.length} bars available; need 26 for a 20-day baseline.`);

  // z-score of each of the last 5 sessions against its own trailing 20-day volume.
  const scan = [0, 1, 2, 3, 4].map((k) => {
    const i = bars.length - 1 - k;
    const window = bars.slice(i - 20, i).map((b) => b.volume);
    const m = mean(window);
    const s = std(window) || 1;
    return { bar: bars[i], z: (bars[i].volume - m) / s, avg: m, ret: bars[i].close / bars[i - 1].close - 1 };
  });
  const spike = scan.reduce((best, x) => (x.z > best.z ? x : best));
  const latest = scan[0];

  let label: Label = "Normal";
  let pick = latest;
  let confidence = 0.5;
  if (spike.z >= 2) {
    label = spike.ret >= 0 ? "Accumulation" : "Distribution";
    pick = spike;
    confidence = clamp(0.45 + 0.08 * (spike.z - 2), 0.45, 0.85);
  } else if (latest.z <= -1.5) {
    label = "Drying-up";
    confidence = 0.45;
  }

  const reasoning =
    label === "Accumulation" || label === "Distribution"
      ? `Volume on ${pick.bar.date} was ${pick.z.toFixed(1)}σ above its 20-day mean on a ${pct(pick.ret)} day, which reads as ${label.toLowerCase()}.`
      : label === "Drying-up"
        ? `Latest volume is ${Math.abs(latest.z).toFixed(1)}σ below its 20-day mean: participation is drying up.`
        : `No session in the last 5 exceeded 2σ (max z ${spike.z.toFixed(1)}); participation is normal.`;

  return {
    label,
    confidence: round2(confidence),
    reasoning,
    citations: [
      {
        ref: `market:${ticker}:volume`,
        kind: "market",
        date: pick.bar.date,
        snippet: `volume ${millions(pick.bar.volume)} vs 20d mean ${millions(pick.avg)} (z=${pick.z.toFixed(2)}) | day return ${pct(pick.ret)} on ${pick.bar.date}`,
      },
    ],
    status: "ok",
  };
}

function sentiment({ ticker, asOf }: AgentContext): Core {
  const dates = getDates();
  const to = dates[asOf];
  const from = dates[Math.max(0, asOf - 29)];
  const items = getHeadlines(ticker).filter((h) => h.date >= from && h.date <= to);
  if (!items.length) return noEvidence(`No ${ticker} headlines in the 30 sessions to ${to}; nothing to score.`);

  let pos = 0;
  let neg = 0;
  for (const h of items) {
    const s = lexicon(h.title);
    pos += s.pos;
    neg += s.neg;
  }
  const score = pos - neg;
  const label: Label = score > 0 ? "Positive" : score < 0 ? "Negative" : "Neutral";

  return {
    label,
    confidence: round2(label === "Neutral" ? 0.35 : clamp(0.4 + 0.1 * Math.abs(score), 0.4, 0.85)),
    reasoning: `${items.length} headline(s) in the last 30 sessions; lexicon found ${pos} positive vs ${neg} negative terms (net ${score >= 0 ? "+" : ""}${score}).`,
    citations: items.map((h) => ({ ref: h.id, kind: "headline" as const, date: h.date, snippet: h.title })),
    status: "ok",
  };
}

// BM25 over paragraph/bullet chunks of /data/docs, with a mild recency decay.
type Chunk = { docId: string; date: string; tickers: Ticker[]; text: string; tokens: string[] };
let chunkCache: Chunk[] | null = null;

function chunks(): Chunk[] {
  chunkCache ??= getDocs().flatMap((doc) =>
    doc.body
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith(">"))
      .map((text) => ({ docId: doc.id, date: doc.date, tickers: doc.tickers, text, tokens: tokenize(text) })),
  );
  return chunkCache;
}

function filingsRag({ ticker, asOf }: AgentContext): Core {
  const asOfDate = getDates()[asOf];
  const corpus = chunks().filter((c) => c.date <= asOfDate);
  const candidates = corpus.filter((c) => c.tickers.includes(ticker));
  if (!candidates.length)
    return noEvidence(`No filing, transcript or note for ${ticker} exists in /data/docs up to ${asOfDate}; retrieval had nothing to cite.`);

  const query = [...new Set(tokenize(`${ticker} ${COMPANY[ticker]} outlook guidance demand margin`))];
  const k1 = 1.2;
  const b = 0.75;
  const avgdl = mean(corpus.map((c) => c.tokens.length));
  const idf = new Map(
    query.map((term) => {
      const df = corpus.filter((c) => c.tokens.includes(term)).length;
      return [term, Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5))];
    }),
  );
  const ageDays = (date: string) => (Date.parse(asOfDate) - Date.parse(date)) / 86_400_000;

  const top = candidates
    .map((c) => {
      const bm25 = query.reduce((sum, term) => {
        const tf = c.tokens.filter((t) => t === term).length;
        if (!tf) return sum;
        return sum + (idf.get(term) ?? 0) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.tokens.length) / avgdl)));
      }, 0);
      return { c, score: bm25 / (1 + ageDays(c.date) / 90) };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
  if (!top.length) return noEvidence(`Documents exist for ${ticker} but no passage matched the retrieval query.`);

  let pos = 0;
  let neg = 0;
  for (const { c } of top) {
    const s = lexicon(c.text);
    pos += s.pos;
    neg += s.neg;
  }
  const label: Label = pos > neg ? "Supportive" : neg > pos ? "Cautionary" : "Neutral";
  const docs = [...new Set(top.map((x) => x.c.docId))];

  return {
    label,
    confidence: round2(label === "Neutral" ? 0.35 : clamp(0.4 + (0.45 * Math.abs(pos - neg)) / (pos + neg), 0.4, 0.85)),
    reasoning: `BM25 retrieved ${top.length} passage(s) from ${docs.join(", ")}; they contain ${pos} supportive vs ${neg} cautionary terms.`,
    citations: top.map(({ c }) => ({ ref: c.docId, kind: "filing" as const, date: c.date, snippet: c.text })),
    status: "ok",
  };
}

// ---------------------------------------------------------------------------
// Public agents
// ---------------------------------------------------------------------------

const CORES: Record<AgentName, (ctx: AgentContext) => Core> = {
  MomentumAgent: momentum,
  VolumeAnomalyAgent: volumeAnomaly,
  SentimentAgent: sentiment,
  FilingsRAGAgent: filingsRag,
};

/** Runs one agent synchronously, times it, and validates the contract. Never throws. */
export function evaluateAgent(agent: AgentName, ctx: AgentContext): AgentResult {
  const t0 = performance.now();
  let core: Core;
  try {
    core = CORES[agent](ctx);
  } catch (err) {
    core = noEvidence(`Agent failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const latencyMs = round2(performance.now() - t0);
  const parsed = AgentResultSchema.safeParse({ agent, ticker: ctx.ticker, ...core, latencyMs });
  if (parsed.success) return parsed.data;
  return { agent, ticker: ctx.ticker, ...noEvidence(`Output failed schema validation: ${parsed.error.issues[0]?.message}`), latencyMs };
}

export const MomentumAgent = async (ctx: AgentContext) => evaluateAgent("MomentumAgent", ctx);
export const VolumeAnomalyAgent = async (ctx: AgentContext) => evaluateAgent("VolumeAnomalyAgent", ctx);
export const SentimentAgent = async (ctx: AgentContext) => evaluateAgent("SentimentAgent", ctx);
export const FilingsRAGAgent = async (ctx: AgentContext) => evaluateAgent("FilingsRAGAgent", ctx);

/** Runs all four agents in parallel; a rejected agent becomes a degraded No-evidence row. */
export async function runAllAgents(ctx: AgentContext): Promise<AgentResult[]> {
  const settled = await Promise.allSettled([
    MomentumAgent(ctx),
    VolumeAnomalyAgent(ctx),
    SentimentAgent(ctx),
    FilingsRAGAgent(ctx),
  ]);
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { agent: AGENT_NAMES[i], ticker: ctx.ticker, ...noEvidence(`Agent rejected: ${String(s.reason)}`), latencyMs: 0 },
  );
}
