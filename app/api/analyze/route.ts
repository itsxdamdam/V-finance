import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_NAMES, PROFILE_NAMES, TICKERS, getSeries } from "@/lib/data";
import { logSession } from "@/lib/metrics";
import { analyze } from "@/lib/synthesis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const flag = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

const QuerySchema = z.object({
  ticker: z.enum(TICKERS).default("RELIANCE"),
  profile: z.enum(PROFILE_NAMES).default("Moderate"),
  feedDown: flag,
  conflict: flag,
  narrate: z.enum(["1", "0"]).default("1"),
  session: z.string().max(64).optional(),
});

// GET /api/analyze?ticker=&profile=&feedDown=&conflict=  (optional: narrate=0, session=<id>)
export async function GET(request: NextRequest) {
  const query = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 },
    );
  }
  const { ticker, profile, feedDown, conflict, narrate, session } = query.data;

  const result = await analyze({ ticker, profileName: profile, feedDown, conflict, withNarrative: narrate === "1" });

  logSession({
    id: randomUUID(),
    sessionId: session ?? "anonymous",
    ts: new Date().toISOString(),
    ticker,
    profile,
    feedDown,
    conflict,
    stance: result.synthesis.stance,
    rawStance: result.synthesis.rawStance,
    confidence: result.synthesis.confidence,
    conflicts: result.synthesis.conflicts.length,
    degraded: result.agents.filter((a) => a.status === "degraded").map((a) => a.agent),
    narrator: result.synthesis.narrative.mode,
    latency: {
      ...Object.fromEntries(AGENT_NAMES.map((name) => [name, result.agents.find((a) => a.agent === name)?.latencyMs ?? 0])),
      endToEnd: result.endToEndMs,
    },
  });

  return NextResponse.json({
    ticker,
    profile,
    flags: { feedDown, conflict, missingFiling: result.agents.some((a) => a.agent === "FilingsRAGAgent" && a.label === "No-evidence") },
    asOf: result.asOf,
    agents: result.agents,
    synthesis: result.synthesis,
    latency: {
      perAgentMs: Object.fromEntries(result.agents.map((a) => [a.agent, a.latencyMs])),
      endToEndMs: result.endToEndMs,
    },
    // With the price feed down, the chart gets no data either.
    prices: feedDown ? null : getSeries(ticker).slice(-90).map((b) => ({ date: b.date, close: b.close })),
  });
}
