import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PROFILE_NAMES } from "@/lib/data";
import { getMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/metrics?profile=
export async function GET(request: NextRequest) {
  const profile = z.enum(PROFILE_NAMES).default("Moderate").safeParse(request.nextUrl.searchParams.get("profile") ?? undefined);
  if (!profile.success) {
    return NextResponse.json({ error: `profile must be one of ${PROFILE_NAMES.join(", ")}` }, { status: 400 });
  }
  return NextResponse.json(getMetrics(profile.data));
}
