// Synthesis: merges the four agent outputs into one cited, profile-aware stance.
// Deterministic by default; if ANTHROPIC_API_KEY is set, Claude rewrites the
// narrative only (stance, confidence and reasoning stay deterministic).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as z4 from "zod/v4";
import {
  CitationSchema,
  direction,
  runAllAgents,
  type AgentResult,
  type Citation,
  type Label,
} from "./agents";
import {
  PROFILE_NAMES,
  getDates,
  getProfiles,
  getSeries,
  type AgentName,
  type ProfileName,
  type Ticker,
} from "./data";

export const DISCLAIMER =
  "Educational demo on synthetic data. Not investment advice: V-Finance does not recommend buying or selling any security.";

export const STANCES = ["Bullish", "Neutral", "Bearish", "Insufficient evidence"] as const;
type Stance = (typeof STANCES)[number];

const StepSchema = z.object({
  kind: z.enum(["evidence", "weighting", "conflict", "risk", "stance", "insufficient"]),
  text: z.string().min(1),
  citations: z.array(z.string()),
});
type Step = z.infer<typeof StepSchema>;

const RiskCheckSchema = z.object({
  check: z.enum(["concentration", "volatility"]),
  status: z.enum(["pass", "flag", "unknown"]),
  detail: z.string(),
  citations: z.array(z.string()),
});
type RiskCheck = z.infer<typeof RiskCheckSchema>;

const SentenceSchema = z.object({ text: z.string().min(1), citations: z.array(z.string()).min(1) });
const NarrativeSchema = z.object({
  mode: z.enum(["llm", "template"]),
  model: z.string().optional(),
  note: z.string().optional(),
  sentences: z.array(SentenceSchema),
});
type Narrative = z.infer<typeof NarrativeSchema>;

export const SynthesisSchema = z
  .object({
    ticker: z.string(),
    profile: z.enum(PROFILE_NAMES),
    asOf: z.string(),
    stance: z.enum(STANCES),
    rawStance: z.enum(STANCES),
    score: z.number().min(-1).max(1),
    confidence: z.number().min(0).max(1),
    evidenceAgents: z.number().int().min(0).max(4),
    conflicts: z.array(z.string()),
    riskChecks: z.array(RiskCheckSchema),
    reasoning: z.array(StepSchema),
    citations: z.array(CitationSchema.extend({ id: z.string() })),
    narrative: NarrativeSchema,
    disclaimer: z.literal(DISCLAIMER),
    status: z.enum(["ok", "degraded"]),
  })
  .superRefine((s, ctx) => {
    // The citation rule, enforced at the contract level.
    const ids = new Set(s.citations.map((c) => c.id));
    const statements = [...s.reasoning, ...s.narrative.sentences.map((x) => ({ ...x, kind: "narrative" }))];
    for (const st of statements) {
      if (st.kind !== "insufficient" && st.citations.length === 0)
        ctx.addIssue({ code: "custom", message: `Uncited statement: ${st.text}` });
      for (const id of st.citations)
        if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `Unknown citation ${id}` });
    }
  });
export type Synthesis = z.infer<typeof SynthesisSchema>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const short = (agent: AgentName) => agent.replace("Agent", "").replace("RAG", " RAG");
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function annualisedVolatility(ticker: Ticker, asOf: number) {
  const closes = getSeries(ticker).slice(Math.max(0, asOf - 60), asOf + 1).map((b) => b.close);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const m = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  return Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length || 1)) * Math.sqrt(252);
}

/** Any statement without a citation is downgraded to an explicit insufficient-evidence step. */
function enforceCitations(steps: Step[]): Step[] {
  return steps.map((s) =>
    s.kind !== "insufficient" && s.citations.length === 0
      ? { kind: "insufficient", text: `Insufficient evidence: ${s.text}`, citations: [] }
      : s,
  );
}

// ---------------------------------------------------------------------------
// Stress test: force disagreement between agents
// ---------------------------------------------------------------------------

const FORCED: Record<AgentName, [Label, Label]> = {
  MomentumAgent: ["Bullish", "Bearish"],
  VolumeAnomalyAgent: ["Accumulation", "Distribution"],
  SentimentAgent: ["Positive", "Negative"],
  FilingsRAGAgent: ["Supportive", "Cautionary"],
};

/**
 * Splits the agents that have evidence into two opposing camps (strongest agent
 * keeps its direction; the rest alternate) so synthesis must handle a real
 * disagreement. Overridden agents are marked degraded and keep their citations.
 */
export function forceConflict(agents: AgentResult[]): AgentResult[] {
  const ranked = agents.filter((a) => a.label !== "No-evidence").sort((a, b) => b.confidence - a.confidence);
  if (ranked.length < 2) return agents;
  const anchor = direction(ranked[0].label) || 1;
  const plan = new Map(ranked.map((a, i) => [a.agent, i === 0 || i === 3 ? anchor : -anchor]));

  return agents.map((a) => {
    const dir = plan.get(a.agent);
    if (!dir) return a;
    const forced = FORCED[a.agent][dir > 0 ? 0 : 1];
    if (forced === a.label) return a;
    return {
      ...a,
      label: forced,
      status: "degraded",
      reasoning: `[Stress test] Forced to ${forced} (computed: ${a.label}) to simulate conflicting signals. ${a.reasoning}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Deterministic synthesis
// ---------------------------------------------------------------------------

type SynthesisInput = {
  ticker: Ticker;
  profileName: ProfileName;
  agents: AgentResult[];
  asOf: number;
  feedDown?: boolean;
  conflictRequested?: boolean;
};

export function synthesize({
  ticker,
  profileName,
  agents,
  asOf,
  feedDown = false,
  conflictRequested = false,
}: SynthesisInput): Synthesis {
  const profile = getProfiles()[profileName];
  const asOfDate = getDates()[asOf];

  // Citation registry: every statement below refers to these ids.
  const citations: (Citation & { id: string })[] = [];
  const cite = (c: Citation) => {
    const existing = citations.find((x) => x.ref === c.ref && x.snippet === c.snippet);
    if (existing) return existing.id;
    const id = `C${citations.length + 1}`;
    citations.push({ id, ...c });
    return id;
  };
  const agentIds = new Map(agents.map((a) => [a.agent, a.citations.map(cite)]));
  const w = profile.agentWeights;
  const profileId = cite({
    ref: `profile:${profileName}`,
    kind: "profile",
    snippet: `${profileName}: stance threshold ±${profile.stanceThreshold}; position cap ${pct0(profile.maxPositionWeight)}; volatility cap ${profile.maxVolatility === null ? "none" : pct0(profile.maxVolatility)}; weights Momentum ×${w.MomentumAgent}, Volume ×${w.VolumeAnomalyAgent}, Sentiment ×${w.SentimentAgent}, Filings ×${w.FilingsRAGAgent}`,
  });

  const steps: Step[] = [];
  const conflicts: string[] = [];
  const evidence = agents.filter((a) => a.label !== "No-evidence");
  const firstIds = (xs: AgentResult[]) => xs.map((a) => agentIds.get(a.agent)?.[0]).filter((x): x is string => !!x);

  for (const a of agents) {
    steps.push(
      a.label === "No-evidence"
        ? { kind: "insufficient", text: `${short(a.agent)}: insufficient evidence. ${a.reasoning}`, citations: [] }
        : { kind: "evidence", text: `${short(a.agent)}: ${a.label} (${pct0(a.confidence)}). ${a.reasoning}`, citations: agentIds.get(a.agent) ?? [] },
    );
  }

  // Profile-weighted vote. Non-directional labels (Neutral, Normal) dilute the score.
  const weightOf = (a: AgentResult) => w[a.agent] * a.confidence;
  const total = evidence.reduce((s, a) => s + weightOf(a), 0);
  const score = total ? evidence.reduce((s, a) => s + weightOf(a) * direction(a.label), 0) / total : 0;
  const bull = evidence.filter((a) => direction(a.label) > 0);
  const bear = evidence.filter((a) => direction(a.label) < 0);
  const bullW = bull.reduce((s, a) => s + weightOf(a), 0);
  const bearW = bear.reduce((s, a) => s + weightOf(a), 0);
  const conflictFactor = bullW > 0 && bearW > 0 ? 1 - Math.min(bullW, bearW) / (bullW + bearW) : 1;

  if (evidence.length >= 2) {
    steps.push({
      kind: "weighting",
      text: `${profileName} weighting across ${evidence.length} evidence agent(s) gives a net score of ${signed(score)} against a ±${profile.stanceThreshold} threshold.`,
      citations: [profileId, ...firstIds(evidence)],
    });
  }
  if (bull.length && bear.length) {
    const text = `${list(bull.map((a) => `${short(a.agent)} (${a.label})`))} point up while ${list(bear.map((a) => `${short(a.agent)} (${a.label})`))} point down; confidence scaled ×${conflictFactor.toFixed(2)}.`;
    conflicts.push(text);
    steps.push({ kind: "conflict", text, citations: firstIds([...bull, ...bear]) });
  }
  if (conflictRequested && evidence.length < 2) {
    const text = `Conflict stress test requested, but only ${evidence.length} agent(s) have evidence, so there is nothing to set against each other.`;
    conflicts.push(text);
    steps.push({ kind: "insufficient", text, citations: [] });
  }

  const threshold = profile.stanceThreshold;
  const rawStance: Stance =
    evidence.length < 2 ? "Insufficient evidence" : score >= threshold ? "Bullish" : score <= -threshold ? "Bearish" : "Neutral";
  let stance = rawStance;
  const profileWeightSum = evidence.reduce((s, a) => s + w[a.agent], 0);
  const avgConfidence = profileWeightSum ? total / profileWeightSum : 0;
  const confidence =
    rawStance === "Insufficient evidence"
      ? 0.1
      : clamp(avgConfidence * (evidence.length / 4) * conflictFactor * (0.5 + 0.5 * Math.abs(score)), 0.05, 0.95);

  // Personalisation: concentration and volatility checks can only make the stance more cautious.
  const riskChecks: RiskCheck[] = [];
  const held = profile.holdings[ticker] ?? 0;
  const cap = profile.maxPositionWeight;
  const holdingId = cite({
    ref: `profile:${profileName}:holdings`,
    kind: "profile",
    snippet: `${ticker} weight ${pct0(held)} of the ${profileName} portfolio; position cap ${pct0(cap)}`,
  });
  if (held >= cap) {
    let detail = `${ticker} is already ${pct0(held)} of the portfolio, at or above the ${pct0(cap)} position cap.`;
    if (stance === "Bullish") {
      stance = "Neutral";
      detail += " Bullish capped at Neutral because adding would deepen the breach.";
    }
    riskChecks.push({ check: "concentration", status: "flag", detail, citations: [holdingId] });
  } else if (held > 0 && stance === "Bearish") {
    riskChecks.push({ check: "concentration", status: "flag", detail: `${ticker} is ${pct0(held)} of the portfolio and the stance is Bearish, so existing exposure is affected.`, citations: [holdingId] });
  } else {
    riskChecks.push({
      check: "concentration",
      status: "pass",
      detail: held > 0 ? `${ticker} is ${pct0(held)} of the portfolio, ${pct0(cap - held)} below the ${pct0(cap)} cap.` : `${ticker} is not held; a position up to ${pct0(cap)} stays within the cap.`,
      citations: [holdingId],
    });
  }

  if (feedDown) {
    let detail = "Price feed is down, so 60-session volatility could not be computed.";
    if (profile.riskTolerance === "low" && stance === "Bullish") {
      stance = "Neutral";
      detail += " A low-risk profile fails safe: Bullish capped at Neutral until risk can be verified.";
    }
    riskChecks.push({ check: "volatility", status: "unknown", detail, citations: [profileId] });
  } else {
    const vol = annualisedVolatility(ticker, asOf);
    const volId = cite({ ref: `market:${ticker}:vol60`, kind: "market", date: asOfDate, snippet: `60-session annualised volatility ${pct0(vol)} as of ${asOfDate}` });
    const limit = profile.maxVolatility;
    if (limit !== null && vol > limit) {
      let detail = `Volatility ${pct0(vol)} exceeds the ${pct0(limit)} tolerance for this profile.`;
      if (stance === "Bullish") {
        stance = "Neutral";
        detail += " Bullish capped at Neutral.";
      }
      riskChecks.push({ check: "volatility", status: "flag", detail, citations: [volId, profileId] });
    } else {
      riskChecks.push({
        check: "volatility",
        status: "pass",
        detail: limit === null ? `Volatility ${pct0(vol)}; this profile sets no volatility cap.` : `Volatility ${pct0(vol)} is within the ${pct0(limit)} tolerance.`,
        citations: [volId, profileId],
      });
    }
  }
  for (const rc of riskChecks) steps.push({ kind: "risk", text: rc.detail, citations: rc.citations });

  steps.push(
    stance === "Insufficient evidence"
      ? { kind: "insufficient", text: `Only ${evidence.length} of 4 agents produced citable evidence, so no directional stance is given.`, citations: [] }
      : {
          kind: "stance",
          text: stance === rawStance
            ? `Final stance: ${stance} at ${pct0(confidence)} confidence.`
            : `Final stance: ${stance} (the signals alone said ${rawStance}; ${profileName} risk limits applied) at ${pct0(confidence)} confidence.`,
          citations: [profileId, ...firstIds(evidence)],
        },
  );

  const reasoning = enforceCitations(steps);

  // Template narrative: each sentence carries the citations of the step it summarises.
  const sentences: Narrative["sentences"] = [];
  if (stance === "Insufficient evidence") {
    sentences.push({ text: `Only ${evidence.length} of 4 agents produced citable evidence for ${ticker}, so V-Finance withholds a directional view.`, citations: firstIds(evidence) });
  } else {
    sentences.push({ text: `For a ${profileName.toLowerCase()} investor, ${ticker} reads ${stance} at ${pct0(confidence)} confidence as of ${asOfDate}.`, citations: [profileId, ...firstIds(evidence)] });
    const strongest = [...bull, ...bear].sort((a, b) => weightOf(b) - weightOf(a))[0];
    if (strongest) {
      sentences.push({ text: `The strongest input is ${short(strongest.agent)} (${strongest.label}): ${strongest.citations[0]?.snippet}.`, citations: firstIds([strongest]) });
    }
  }
  if (bull.length && bear.length) {
    sentences.push({ text: `The agents disagree, so confidence was scaled by ×${conflictFactor.toFixed(2)}.`, citations: firstIds([...bull, ...bear]) });
  }
  for (const rc of riskChecks.filter((r) => r.status !== "pass")) sentences.push({ text: rc.detail, citations: rc.citations });

  return SynthesisSchema.parse({
    ticker,
    profile: profileName,
    asOf: asOfDate,
    stance,
    rawStance,
    score: round2(score),
    confidence: round2(confidence),
    evidenceAgents: evidence.length,
    conflicts,
    riskChecks,
    reasoning,
    citations,
    narrative: { mode: "template", sentences: sentences.filter((s) => s.citations.length > 0) },
    disclaimer: DISCLAIMER,
    status: agents.some((a) => a.status === "degraded") || stance === "Insufficient evidence" ? "degraded" : "ok",
  });
}

// ---------------------------------------------------------------------------
// Optional LLM narrative (only when ANTHROPIC_API_KEY is set)
// ---------------------------------------------------------------------------

export const llmEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

const LlmNarrativeSchema = z4.object({
  sentences: z4.array(z4.object({ text: z4.string(), citations: z4.array(z4.string()) })),
});

const NARRATOR_SYSTEM = `You explain a pre-computed stock signal on an educational dashboard that runs on synthetic data.
Write 2 to 4 short sentences in plain English using only the facts in the provided reasoning steps and citations.
Each sentence must list the ids of the citations that support it (for example "C2"). Use only ids from the provided list, and do not put ids inside the sentence text.
Do not change the stance or the confidence, do not introduce numbers or facts that are not in the input, and do not tell the reader to buy, sell or hold anything.`;

const narrativeCache = new Map<string, Narrative>();

export async function narrate(s: Synthesis): Promise<Synthesis> {
  if (!llmEnabled()) return s;
  const key = JSON.stringify([s.ticker, s.profile, s.stance, s.confidence, s.reasoning]);
  const cached = narrativeCache.get(key);
  if (cached) return { ...s, narrative: cached };

  try {
    const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(LlmNarrativeSchema) },
      system: NARRATOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            ticker: s.ticker,
            profile: s.profile,
            asOf: s.asOf,
            stance: s.stance,
            signalsOnlyStance: s.rawStance,
            confidence: s.confidence,
            reasoning: s.reasoning,
            citations: s.citations.map(({ id, kind, snippet }) => ({ id, kind, snippet })),
          }),
        },
      ],
    });
    if (response.stop_reason === "refusal") throw new Error("model declined");
    if (!response.parsed_output) throw new Error(`unparseable output (stop_reason ${response.stop_reason})`);

    // Re-apply the citation rule to the model's output: unknown ids are removed, uncited sentences dropped.
    const valid = new Set(s.citations.map((c) => c.id));
    const proposed = response.parsed_output.sentences;
    const sentences = proposed
      .map((x) => ({
        text: x.text.replace(/\s*\[?\bC\d+\b\]?/g, "").trim(),
        citations: [...new Set(x.citations.filter((id) => valid.has(id)))],
      }))
      .filter((x) => x.text && x.citations.length > 0);
    if (!sentences.length) throw new Error("no cited sentences survived validation");

    const dropped = proposed.length - sentences.length;
    const narrative: Narrative = {
      mode: "llm",
      model: response.model,
      note: dropped ? `${dropped} uncited sentence(s) from the model were dropped.` : undefined,
      sentences,
    };
    narrativeCache.set(key, narrative);
    return SynthesisSchema.parse({ ...s, narrative });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...s, narrative: { ...s.narrative, note: `LLM narrative unavailable (${reason}); deterministic template shown.` } };
  }
}

// ---------------------------------------------------------------------------
// Pipeline used by /api/analyze
// ---------------------------------------------------------------------------

export async function analyze({
  ticker,
  profileName,
  feedDown,
  conflict,
  withNarrative = true,
}: {
  ticker: Ticker;
  profileName: ProfileName;
  feedDown: boolean;
  conflict: boolean;
  withNarrative?: boolean;
}) {
  const t0 = performance.now();
  const asOf = getDates().length - 1;
  let agents = await runAllAgents({ ticker, asOf, feedDown });
  if (conflict) agents = forceConflict(agents);
  let synthesis = synthesize({ ticker, profileName, agents, asOf, feedDown, conflictRequested: conflict });
  if (withNarrative) synthesis = await narrate(synthesis);
  return { asOf: synthesis.asOf, agents, synthesis, endToEndMs: round2(performance.now() - t0) };
}
