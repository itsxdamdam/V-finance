# V-Finance

**Four independent signal agents, one cited and profile-aware synthesis.** Built for hackathon problem statement **PS 04**.

V-Finance analyses 8 NSE tickers. A momentum agent, a volume-anomaly agent, a headline-sentiment agent and a filings retrieval (RAG) agent each produce a labelled, cited signal. A synthesis layer merges them into one stance for a specific investor profile, applies that profile's risk limits, flags disagreement between agents, and drops any statement that has no citation.

> **All data is synthetic** (deterministic, `seed=42`). No market APIs, no database, no API key required. **Educational demo, not investment advice.**

## Run it (3 commands)

Requires **Node 18.17 to 24** (Node 20 recommended; `.nvmrc` is included).

```bash
nvm use 20      # or any Node 18.17–24
npm install
npm run dev     # open http://localhost:3000
```

`npm run dev` seeds `/data` automatically if it is missing. Other scripts:

| Command | What it does |
|---|---|
| `npm run build && npm start` | Production build (re-seeds deterministically first), then serve on :3000 |
| `npm run seed` | Regenerate all synthetic data (keeps session logs) |
| `npm run seed -- --reset` | Regenerate data and clear `data/sessions.json` |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript checks |

**Optional LLM narrative.** Put `ANTHROPIC_API_KEY=...` in `.env.local` and Claude (`claude-opus-5-5` by default, override with `ANTHROPIC_MODEL`) rewrites the synthesis narrative. It never changes the stance or confidence; its sentences are re-checked against the citation list, and any failure falls back to the deterministic template. Without a key, everything works the same.

## Deploy on Vercel

Import the GitHub repo at [vercel.com/new](https://vercel.com/new). Next.js is detected automatically and no environment variables are needed (`ANTHROPIC_API_KEY` is optional). `/data` is bundled with the API functions (`outputFileTracingIncludes` in `next.config.mjs`). Because Vercel's filesystem is read-only, the session log is written to `/tmp/sessions.json` there: it persists while an instance stays warm and resets on cold starts, so the latency panel shows recent runs only.

## 2-minute demo script for judges

| Time | Do this | What to point out |
|---|---|---|
| 0:00 | Open `http://localhost:3000` | Synthetic-data banner, profile switcher, ticker picker, three degraded-data toggles. |
| 0:15 | Click **TATAMOTORS**, profile **Moderate** | All four agents agree (Bearish momentum, volume *Distribution* on a −10.8% day, negative headlines, cautionary filings), giving a **Bearish** stance at 83% confidence. Click any `C#` chip to jump to its source snippet. |
| 0:35 | Toggle **Force conflicting signals** | Agents split 2-vs-2. Overridden rows show `⚠ degraded · forced`, a *Conflicting signals* box appears, confidence drops to about 22%, and the stance falls back to **Neutral** rather than picking a side. |
| 0:55 | Turn conflict off. Toggle **Missing filing** (switches to **SBIN**) | Filings RAG returns `No-evidence` and is marked degraded: SBIN has no documents in the corpus. Synthesis continues with the 3 remaining agents. |
| 1:10 | Click **Compare all 3 profiles on SBIN** | Same agent outputs, different answers: **Conservative → Neutral** ("signals said Bullish", capped because 60-day volatility exceeds its 28% tolerance) while **Moderate** and **Aggressive** stay **Bullish**. |
| 1:25 | Toggle **Price feed down** | Momentum and Volume become `No-evidence`, and the chart is replaced by a feed-down notice. With only 1 of 4 agents left, the stance is **Insufficient evidence**: it refuses to guess. |
| 1:40 | Switch to **Conservative**, look at the right column | The HDFCBANK holding is flagged **over cap** (40% vs 25%); HHI and effective N are shown. The metrics panel shows backtest hit rates against an "always up" base rate, plus p50/max latency from `data/sessions.json`. |

Every state is a shareable URL, for example `/?ticker=TATAMOTORS&profile=Moderate&conflict=1` or `/?ticker=SBIN&profile=Conservative&feedDown=1`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/analyze?ticker=&profile=&feedDown=&conflict=` | Four agent results, the synthesis (stance, confidence, reasoning chain, citations, risk checks, narrative), latency, and the last 90 closes (`null` when the feed is down). Optional: `narrate=0`, `session=<id>`. Each call is logged to `data/sessions.json`. |
| `GET /api/metrics?profile=` | Backtest hit rates (per agent and synthesis), latency p50/max, portfolio concentration (HHI, top holding), lexicon sanity check. |
| `GET /api/profiles` | The 3 profiles, tickers, dataset range, and narrator mode. |

Invalid tickers or profiles return HTTP 400 with the zod validation message.

```bash
curl "http://localhost:3000/api/analyze?ticker=TATAMOTORS&profile=Moderate&conflict=1"
```

## Project layout

```
app/page.tsx            single-page dashboard (client component)
app/api/*/route.ts      analyze, metrics, profiles
lib/data.ts             synthetic data generators (seed=42) + fs loaders
lib/agents.ts           the four agents + zod output contract
lib/synthesis.ts        merge, conflicts, personalisation, citation rule, optional LLM narrative
lib/metrics.ts          backtest, latency stats, concentration, session log
scripts/seed.ts         CLI wrapper around the generators
data/                   market.json, headlines.json, profiles.json, sessions.json, docs/*.md
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for agent contracts, synthesis maths, degraded-data handling, the metrics method, and limitations.

## Tech

Next.js 14 (App Router) · TypeScript · Tailwind CSS · zod · Node `fs` JSON persistence · optional Anthropic TypeScript SDK. A responsive web app, tested locally on macOS with Node 20. It is plain Node with no native dependencies, so Linux and Windows should work the same.

---

*V-Finance runs on synthetic data and is an educational demo. It is not investment advice and does not recommend buying or selling any security. Company names are used only as labels; every price, headline and document is generated.*
