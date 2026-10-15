# V-Finance architecture

One Next.js 14 App Router project. No database, no external market APIs: synthetic data lives in `/data` and is read and written with Node `fs`. The only optional network call is an LLM narrative when `ANTHROPIC_API_KEY` is set.

```
                 GET /api/analyze?ticker&profile&feedDown&conflict
                                     │
        ┌──────────── Promise.allSettled (parallel) ─────────────┐
        ▼                 ▼                  ▼                   ▼
  MomentumAgent   VolumeAnomalyAgent   SentimentAgent     FilingsRAGAgent
  market.json      market.json          headlines.json     data/docs/*.md (BM25)
        └─────────────── AgentResult[] (zod-validated) ──────────┘
                                     │
                      conflict=1 ? forceConflict()
                                     │
                     synthesize(profile)  ── deterministic
                     • profile-weighted vote → stance
                     • conflict detection → confidence penalty
                     • concentration + volatility checks
                     • citation rule (uncited → insufficient evidence)
                                     │
                     narrate()  ── only if ANTHROPIC_API_KEY
                                     │
                     logSession() → data/sessions.json
```

## 1. Agents (`lib/agents.ts`)

Every agent is an `async` function taking `{ ticker, asOf, feedDown }`. `asOf` is a bar index, so the same code runs live (last bar) and in the backtest (any past bar, with no look-ahead). Agents never throw: exceptions and missing inputs become `status: "degraded", label: "No-evidence"`.

| Agent | Input (point-in-time) | Method | Labels |
|---|---|---|---|
| **MomentumAgent** | Closes up to `asOf` | 20- vs 50-day moving-average crossover with a ±0.5% dead band sets direction; 14-day Wilder RSI confirms (+0.1 confidence) or fades (−0.1) it | Bullish · Bearish · Neutral |
| **VolumeAnomalyAgent** | Volumes up to `asOf` | z-score of each of the last 5 sessions against its own trailing 20-day mean/stdev. z ≥ 2 on an up day = accumulation, on a down day = distribution. Latest z ≤ −1.5 = drying up | Accumulation · Distribution · Normal · Drying-up |
| **SentimentAgent** | Headlines dated in the last 30 sessions | Positive/negative word lexicon over titles; net count sets the label | Positive · Negative · Neutral |
| **FilingsRAGAgent** | `data/docs/*.md` dated ≤ as-of date | In-memory **BM25** (k1 = 1.2, b = 0.75) over paragraph/bullet chunks, limited to documents tagged with the ticker, with recency decay `1/(1 + ageDays/90)`. The top 3 chunks are cited (docId + snippet) and their lexicon balance sets the label | Supportive · Cautionary · Neutral |

`runAllAgents` runs the four with `Promise.allSettled`; a rejected promise becomes a degraded `No-evidence` row for that same agent.

### Output contract (zod `AgentResultSchema`)

```ts
{
  agent: "MomentumAgent" | "VolumeAnomalyAgent" | "SentimentAgent" | "FilingsRAGAgent",
  ticker: string,
  label: "Bullish" | "Bearish" | "Neutral" | "Accumulation" | "Distribution" | "Normal" |
         "Drying-up" | "Positive" | "Negative" | "Supportive" | "Cautionary" | "No-evidence",
  confidence: number,          // 0..1 (0 for No-evidence)
  reasoning: string,
  citations: { ref: string; kind: "market" | "headline" | "filing" | "profile"; snippet: string; date?: string }[],
  latencyMs: number,           // performance.now(), 0.01 ms resolution
  status: "ok" | "degraded",
}
```

Refinements enforced by the schema: `No-evidence` ⇒ `degraded`, and any other label must carry at least one citation. If an agent's output fails validation, it is replaced by a degraded `No-evidence` row rather than reaching the UI.

## 2. Synthesis (`lib/synthesis.ts`)

Each label maps to a direction *d*: +1 (Bullish, Accumulation, Positive, Supportive), −1 (Bearish, Distribution, Negative, Cautionary), or 0 (Neutral, Normal, Drying-up). Only agents with evidence (label ≠ No-evidence) take part.

| Quantity | Definition |
|---|---|
| Weight | *wᵢ* = profile weight of the agent × agent confidence |
| Score | *s* = Σ *wᵢ dᵢ* / Σ *wᵢ* (non-directional agents dilute the score) |
| Raw stance | Bullish if *s* ≥ θ, Bearish if *s* ≤ −θ, else Neutral; **Insufficient evidence** if fewer than 2 agents have evidence |
| Conflict factor | If both bullish weight *W⁺* and bearish weight *W⁻* are > 0: 1 − min(*W⁺*, *W⁻*) / (*W⁺* + *W⁻*), otherwise 1 |
| Confidence | clamp(weighted mean confidence × (evidence agents / 4) × conflict factor × (0.5 + 0.5·\|*s*\|), 0.05, 0.95); 0.10 when evidence is insufficient |

**Personalisation by profile** (`data/profiles.json`):

| Profile | θ | Momentum / Volume / Sentiment / Filings weights | Position cap | Volatility cap |
|---|---|---|---|---|
| Conservative | 0.35 | 0.7 / 0.5 / 1.0 / 1.4 | 25% | 28% |
| Moderate | 0.25 | 1.0 / 1.0 / 1.0 / 1.1 | 30% | 40% |
| Aggressive | 0.15 | 1.4 / 1.2 / 0.9 / 0.6 | 50% | none |

Risk checks can only make the stance **more cautious**:

- **Concentration.** If the ticker's portfolio weight is at or above the position cap, a Bullish stance is capped at Neutral. A held position with a Bearish stance is flagged.
- **Volatility.** 60-session annualised volatility above the profile's cap caps Bullish at Neutral. When the price feed is down, volatility cannot be computed; the check reports `unknown`, and a low-risk profile fails safe (Bullish capped at Neutral).

The output keeps both `rawStance` (from the signals alone) and `stance` (after risk limits), so the UI can say "signals said Bullish; Conservative risk limits applied".

**Conflict detection** names both sides (for example "Momentum (Bullish) points up while Volume (Distribution) and Sentiment (Negative) point down") and applies the conflict factor above.

### Citation rule

1. Every agent citation, profile setting and computed risk number is registered as `C1…Cn`.
2. Every reasoning step (`evidence`, `weighting`, `conflict`, `risk`, `stance`) carries the ids it relies on.
3. `enforceCitations()` turns any uncited step into an explicit **"Insufficient evidence: …"** step.
4. `SynthesisSchema.superRefine` rejects any non-insufficient statement without citations, and any citation id that does not exist.
5. The **LLM narrative**, if enabled, returns `{ sentences: [{ text, citations[] }] }` through structured output (zod schema via `zodOutputFormat`). Unknown ids are removed and uncited sentences dropped. If nothing survives, or on timeout, refusal or parse failure, the deterministic template narrative is kept and the reason is shown. The LLM never sets stance or confidence. Requests use `claude-opus-5-5` at low effort with server-side refusal fallback (`fallbacks: "default"`) and a 20 s timeout. Responses are cached in memory per identical input.

Every synthesis carries the disclaimer: *"Educational demo on synthetic data. Not investment advice."*

### Synthesis contract (zod `SynthesisSchema`, abridged)

```ts
{
  ticker, profile, asOf,
  stance: "Bullish" | "Neutral" | "Bearish" | "Insufficient evidence",
  rawStance, score /* -1..1 */, confidence /* 0..1 */, evidenceAgents /* 0..4 */,
  conflicts: string[],
  riskChecks: { check: "concentration" | "volatility"; status: "pass" | "flag" | "unknown"; detail; citations: string[] }[],
  reasoning: { kind: "evidence" | "weighting" | "conflict" | "risk" | "stance" | "insufficient"; text; citations: string[] }[],
  citations: { id: "C1", ref, kind, snippet, date? }[],
  narrative: { mode: "template" | "llm"; model?; note?; sentences: { text; citations: string[] /* ≥1 */ }[] },
  disclaimer, status: "ok" | "degraded",
}
```

## 3. Degraded-data handling

| Trigger | Effect | How it shows |
|---|---|---|
| `feedDown=1` ("Price feed down") | Momentum and Volume return `No-evidence` and are degraded; no prices are returned; the volatility check becomes `unknown` | `⚠ degraded` badges, chart replaced by a feed-down notice, `insufficient evidence` steps |
| SBIN ("Missing filing") | No document in `data/docs` is tagged SBIN, so retrieval returns nothing and Filings RAG is `No-evidence`. Nothing special-cases SBIN in code; it falls out of the data | Degraded Filings row; synthesis continues with the remaining agents |
| `conflict=1` ("Force conflicting signals") | `forceConflict()` ranks the agents that have evidence by confidence. The strongest keeps its direction; the others are assigned so the two sides are roughly balanced (positions 1 and 4 vs 2 and 3). Overridden agents get status `degraded` and a `[Stress test]` prefix, and keep their original evidence | `⚠ degraded · forced`, *Conflicting signals* box, lower confidence, usually a Neutral stance |
| Fewer than 2 agents with evidence | Stance = **Insufficient evidence**, confidence 0.10 | Explicit refusal instead of a guess |
| Agent exception or schema failure | That agent becomes a degraded `No-evidence` row | The rest of the pipeline is unaffected |

## 4. Metrics (`lib/metrics.ts`)

**Hit rate vs 30-day forward returns (point-in-time backtest).** For each of the 8 tickers and each as-of bar *t* from 50 to 149 (800 samples, 2024-03-11 to 2024-07-26), the agents run on data available at *t* only: bars ≤ *t*, headlines in the 30 sessions to *t*, documents dated ≤ *t*. A call is a non-zero direction. It is a hit when sign(call) = sign(close[*t*+30] / close[*t*] − 1). Neutral, Normal, Drying-up and No-evidence are not calls; **coverage** = calls / samples. Synthesis is scored the same way per profile (Bullish = +1, Bearish = −1). The backtest runs on clean data (no feed-down or forced conflict) and never calls the LLM. Results are cached in memory, since the data is deterministic.

**Base rate.** The share of samples with a positive forward return (55.9%) is shown as a reference line: the hit rate of an "always up" call.

**Current results** (deterministic):

| | Hit rate | Calls (coverage) |
|---|---|---|
| Momentum | 56.3% | 732 (92%) |
| Volume | 51.8% | 195 (24%) |
| Sentiment | 54.1% | 368 (46%) |
| Filings RAG | 34.2% | 549 (69%) |
| Synthesis: Conservative / Moderate / Aggressive | 38.4% / 46.5% / 52.9% | 305 / 518 / 662 |
| *Base rate (always up)* | *55.9%* | |

**Interpretation, stated plainly.** Prices are a seeded random walk, so no agent should be expected to beat the base rate, and none does. Filings RAG scores worst because the synthetic documents lean cautionary while most synthetic prices drift up; Conservative synthesis inherits that because it weights filings most. The harness is the deliverable here: point-in-time inputs, coverage-aware hit rates and an explicit base rate. It is not evidence of predictive power.

**Latency.** Each agent is timed with `performance.now()`. End-to-end covers the full `/api/analyze` pipeline, including the LLM call when enabled. Every request appends a session entry to `data/sessions.json` (`/tmp/sessions.json` on Vercel; agent latencies, end-to-end, stance, flags, degraded agents, narrator mode, session id; capped at 1000 entries). The metrics endpoint reports p50 and max over the last 500 entries. In `next dev`, React Strict Mode double-invokes effects, so each UI change logs two runs; production logs one.

**Portfolio concentration.** HHI = Σ wᵢ², effective holdings = 1/HHI, top holding weight, and holdings above the profile's position cap.

**Lexicon sanity check.** The share of headlines whose lexicon polarity matches the seeded `polarityHint` (currently 100% of 40, which is expected because the headlines are templated).

## 5. Synthetic data (`lib/data.ts`, `npm run seed`)

| Dataset | Generation (seed 42, mulberry32 PRNG) |
|---|---|
| `market.json` | 8 tickers × 180 weekday sessions (2024-01-01 to 2024-09-06). Geometric Brownian motion with per-ticker drift and volatility (16%–42% annualised) and realistic NSE-like price levels. **Injected extremes:** two forced shock days per ticker (−10.8% to +9.2%) with 2.7–4.8× volume, including TATAMOTORS −10.8% on the final bar and ICICIBANK +5.5% on the second-to-last |
| `headlines.json` | 5 per ticker (40 total): one dated on each shock day with matching polarity, plus three at seeded-random dates with seeded-random polarity. Each has a `polarityHint` |
| `data/docs/*.md` | 16 markdown filings, earnings-call transcripts and notes with front-matter (`id, tickers, date, type, title`), each labelled synthetic. **None for SBIN** |
| `profiles.json` | Conservative, Moderate, Aggressive: holdings, watchlist, weights, caps, thresholds |
| `sessions.json` | Runtime log; created if missing, never overwritten by a normal seed |

Seeding runs on `npm run build` (always, deterministically), on `npm run dev` / `npm start` when `/data` is missing, and lazily at runtime if a file disappears.

## 6. Limitations

- **Everything is synthetic.** Real NSE company names are used only as labels; prices, headlines and documents are generated, and none of it describes the real companies.
- **The generated world has no predictive structure.** Headline polarity is random apart from the shock days, and document tone is hand-written and not linked to the price paths. Hit rates near the base rate are the honest result.
- **Simple NLP.** The lexicon has no negation or context handling; BM25 runs over a 16-document corpus with no embeddings; there are no stemming or synonyms.
- **Hand-set parameters.** Thresholds, weights and caps were chosen by hand, not fitted, and are not calibrated probabilities. Confidence is a heuristic score.
- **Calendar.** Weekdays only; exchange holidays are ignored.
- **Persistence.** JSON on local disk with synchronous writes. This is safe for one Node process and not suitable for multiple instances. On Vercel the seed data ships read-only with the functions and the session log lives in `/tmp`, so it is per instance and resets on cold starts. If a log write fails, it is skipped with a warning and analysis still works.
- **Stress tests are labelled.** Forced conflict overrides labels for demonstration, and those rows are always marked degraded.
- **Not investment advice.** The dashboard explains signals; it does not recommend trades.
