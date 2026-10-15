import { NextResponse } from "next/server";
import { BARS, COMPANY, SEED, TICKERS, getDates, getProfiles } from "@/lib/data";
import { llmEnabled } from "@/lib/synthesis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/profiles
export async function GET() {
  const dates = getDates();
  return NextResponse.json({
    profiles: getProfiles(),
    tickers: TICKERS.map((ticker) => ({ ticker, name: COMPANY[ticker] })),
    dataset: { synthetic: true, seed: SEED, bars: BARS, from: dates[0], to: dates[dates.length - 1] },
    narrator: llmEnabled() ? "llm" : "template",
  });
}
