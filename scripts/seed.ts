// Usage: tsx scripts/seed.ts [--if-missing] [--reset]
//   --if-missing  only seed when /data is absent (used by predev/prestart)
//   --reset       also clear data/sessions.json
import { isSeeded, seedAll } from "../lib/data";

const args = process.argv.slice(2);

if (args.includes("--if-missing") && isSeeded()) {
  console.log("[seed] /data already present; skipping.");
} else {
  const summary = seedAll({ resetSessions: args.includes("--reset") });
  console.log(
    `[seed] seed=42: ${summary.tickers} tickers x ${summary.bars} trading days (${summary.from} to ${summary.to}), ${summary.docs} docs, 3 profiles.`,
  );
}
