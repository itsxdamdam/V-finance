// Synthetic data layer: deterministic generators (seed=42) plus fs-backed loaders.
// Everything under /data is generated here; nothing comes from a real market feed.
import fs from "fs";
import path from "path";

export const SEED = 42;
export const BARS = 180;
export const TICKERS = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "ITC",
  "SBIN",
  "TATAMOTORS",
] as const;
export type Ticker = (typeof TICKERS)[number];

export const COMPANY: Record<Ticker, string> = {
  RELIANCE: "Reliance Industries",
  TCS: "Tata Consultancy Services",
  INFY: "Infosys",
  HDFCBANK: "HDFC Bank",
  ICICIBANK: "ICICI Bank",
  ITC: "ITC",
  SBIN: "State Bank of India",
  TATAMOTORS: "Tata Motors",
};

export const PROFILE_NAMES = ["Conservative", "Moderate", "Aggressive"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const AGENT_NAMES = [
  "MomentumAgent",
  "VolumeAnomalyAgent",
  "SentimentAgent",
  "FilingsRAGAgent",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export type Bar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Polarity = "positive" | "negative" | "neutral";
export type Headline = {
  id: string;
  ticker: Ticker;
  date: string;
  title: string;
  polarityHint: Polarity;
};
export type Doc = {
  id: string;
  tickers: Ticker[];
  date: string;
  type: "filing" | "transcript" | "note";
  title: string;
  body: string;
};
export type Profile = {
  label: string;
  description: string;
  riskTolerance: "low" | "medium" | "high";
  horizon: "short" | "medium" | "long";
  holdings: Partial<Record<Ticker, number>>;
  watchlist: Ticker[];
  maxPositionWeight: number;
  maxVolatility: number | null;
  stanceThreshold: number;
  agentWeights: Record<AgentName, number>;
};
type MarketFile = {
  seed: number;
  synthetic: true;
  dates: string[];
  data: Record<Ticker, Bar[]>;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DOCS_DIR = path.join(DATA_DIR, "docs");
export const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const dataFile = (name: string) => path.join(DATA_DIR, name);

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Weekdays only, starting 2024-01-01. Exchange holidays are ignored.
function tradingDays(n: number) {
  const out: string[] = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Injected extremes: on a shock day the return is forced and volume is multiplied.
type Shock = { day: number; ret: number; volMult: number };
type Spec = {
  start: number;
  mu: number;
  sigma: number;
  volume: number;
  shocks: Shock[];
};

const SPECS: Record<Ticker, Spec> = {
  RELIANCE: { start: 2580, mu: 0.16, sigma: 0.22, volume: 6.5e6, shocks: [{ day: 64, ret: 0.072, volMult: 3.6 }, { day: 121, ret: -0.061, volMult: 3.1 }] },
  TCS: { start: 3780, mu: 0.04, sigma: 0.19, volume: 2.6e6, shocks: [{ day: 90, ret: -0.081, volMult: 4.1 }, { day: 150, ret: 0.052, volMult: 2.9 }] },
  INFY: { start: 1610, mu: -0.06, sigma: 0.25, volume: 7.2e6, shocks: [{ day: 72, ret: -0.095, volMult: 4.4 }, { day: 165, ret: 0.061, volMult: 3.2 }] },
  HDFCBANK: { start: 1660, mu: 0.02, sigma: 0.21, volume: 1.5e7, shocks: [{ day: 40, ret: -0.068, volMult: 3.8 }, { day: 140, ret: 0.046, volMult: 2.7 }] },
  ICICIBANK: { start: 990, mu: 0.2, sigma: 0.24, volume: 1.4e7, shocks: [{ day: 110, ret: 0.061, volMult: 3.3 }, { day: 178, ret: 0.055, volMult: 3.5 }] },
  ITC: { start: 452, mu: 0.08, sigma: 0.16, volume: 1.2e7, shocks: [{ day: 55, ret: 0.041, volMult: 2.8 }, { day: 130, ret: -0.052, volMult: 3.0 }] },
  SBIN: { start: 640, mu: 0.14, sigma: 0.3, volume: 1.8e7, shocks: [{ day: 85, ret: -0.072, volMult: 3.9 }, { day: 160, ret: 0.083, volMult: 4.2 }] },
  TATAMOTORS: { start: 780, mu: 0.3, sigma: 0.42, volume: 2.0e7, shocks: [{ day: 50, ret: 0.092, volMult: 4.0 }, { day: 179, ret: -0.108, volMult: 4.8 }] },
};

function generateMarket(): MarketFile {
  const dates = tradingDays(BARS);
  const dt = 1 / 252;
  const data = {} as Record<Ticker, Bar[]>;

  TICKERS.forEach((ticker, i) => {
    const spec = SPECS[ticker];
    const rand = mulberry32(SEED + i * 1009);
    const sd = spec.sigma * Math.sqrt(dt);
    const bars: Bar[] = [];
    let prev = spec.start;

    for (let day = 0; day < BARS; day++) {
      const shock = spec.shocks.find((s) => s.day === day);
      // Geometric Brownian motion step, unless an extreme is injected.
      const ret = shock
        ? shock.ret
        : Math.exp((spec.mu - (spec.sigma * spec.sigma) / 2) * dt + sd * gaussian(rand)) - 1;
      const close = prev * (1 + ret);
      const open = shock ? prev * (1 + ret * 0.6) : prev * (1 + sd * 0.25 * gaussian(rand));
      const high = Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * sd * 0.6);
      const low = Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * sd * 0.6);
      const volume = Math.round(
        spec.volume * Math.exp(0.25 * gaussian(rand)) * (1 + 6 * Math.abs(ret)) * (shock?.volMult ?? 1),
      );
      bars.push({ date: dates[day], open: round2(open), high: round2(high), low: round2(low), close: round2(close), volume });
      prev = close;
    }
    data[ticker] = bars;
  });

  return { seed: SEED, synthetic: true, dates, data };
}

const SHORT_NAME: Record<Ticker, string> = {
  RELIANCE: "Reliance",
  TCS: "TCS",
  INFY: "Infosys",
  HDFCBANK: "HDFC Bank",
  ICICIBANK: "ICICI Bank",
  ITC: "ITC",
  SBIN: "SBI",
  TATAMOTORS: "Tata Motors",
};
const DRIVER: Record<Ticker, string> = {
  RELIANCE: "retail demand",
  TCS: "deal flow",
  INFY: "client spending",
  HDFCBANK: "loan book",
  ICICIBANK: "retail lending",
  ITC: "FMCG demand",
  SBIN: "credit offtake",
  TATAMOTORS: "JLR demand",
};
const HEADLINE_TEMPLATES: Record<Polarity, string[]> = {
  positive: [
    "{n} beats estimates as {d} stays strong",
    "Brokerages upgrade {n} after robust quarterly numbers",
    "{n} wins large multi-year order; shares rally",
    "{n} raises outlook on record {d}",
  ],
  negative: [
    "{n} slides as margin pressure weighs on outlook",
    "{n} misses estimates; analysts flag weak {d}",
    "{n} shares fall after regulator opens probe",
    "{n} cuts guidance amid slowing {d}",
  ],
  neutral: [
    "{n} board to consider dividend at upcoming meeting",
    "{n} management reiterates full-year guidance",
    "{n} announces leadership change at a key business unit",
    "{n} to present at investor conference next week",
  ],
};

// ~5 headlines per ticker: one on each injected extreme (polarity matches the move),
// plus three at seeded-random days with seeded-random polarity.
function generateHeadlines(dates: string[]) {
  const data = {} as Record<Ticker, Headline[]>;
  const polarities: Polarity[] = ["positive", "negative", "neutral"];

  TICKERS.forEach((ticker, i) => {
    const rand = mulberry32(SEED * 7 + i);
    const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
    // Draw templates without replacement so a ticker never repeats a headline.
    const pool = Object.fromEntries(
      polarities.map((p) => [p, [...HEADLINE_TEMPLATES[p]]]),
    ) as Record<Polarity, string[]>;
    const draw = (p: Polarity) => pool[p].splice(Math.floor(rand() * pool[p].length), 1)[0];
    const slots: { day: number; polarity: Polarity }[] = [
      ...SPECS[ticker].shocks.map((s) => ({
        day: s.day,
        polarity: (s.ret > 0 ? "positive" : "negative") as Polarity,
      })),
      { day: 10 + Math.floor(rand() * 40), polarity: "neutral" },
      { day: 80 + Math.floor(rand() * 50), polarity: pick(polarities) },
      { day: 150 + Math.floor(rand() * 28), polarity: pick(polarities) },
    ];
    data[ticker] = slots
      .sort((a, b) => a.day - b.day)
      .map((slot, n) => ({
        id: `${ticker.toLowerCase()}-h${n + 1}`,
        ticker,
        date: dates[slot.day],
        title: draw(slot.polarity)
          .replace("{n}", SHORT_NAME[ticker])
          .replace("{d}", DRIVER[ticker]),
        polarityHint: slot.polarity,
      }));
  });
  return data;
}

// 16 synthetic documents. SBIN deliberately has none: the "missing filing" case.
const DOC_SPECS: [string, Ticker[], string, Doc["type"], string, string[]][] = [
  ["doc-01", ["RELIANCE"], "2024-02-12", "filing", "Reliance Industries: Q3 operational update", [
    "Retail footprint expansion continued, with strong footfall across grocery and fashion formats.",
    "Digital services subscriber additions remained robust and average revenue per user was stable.",
    "Refining margins were stable quarter on quarter despite volatile crude prices.",
    "Management guidance points to continued capex in new energy, funded largely from operating cash flow.",
    "Key risk: elevated capex could weigh on free cash flow if retail demand slows.",
  ]],
  ["doc-02", ["RELIANCE"], "2024-05-21", "transcript", "Reliance Industries: Q4 earnings call (excerpt)", [
    "Analysts questioned the pace of capex and the pressure it puts on net debt.",
    "Management acknowledged weak demand in petrochemicals and a margin headwind from Chinese supply.",
    "Retail revenue moderated as the company closed unprofitable stores.",
    "New energy commissioning guidance was delayed by two quarters.",
    "Digital services remain the strongest earnings engine.",
  ]],
  ["doc-03", ["TCS"], "2024-01-15", "filing", "Tata Consultancy Services: Q3 results filing", [
    "Total contract value of deal wins reached a record level, giving strong revenue visibility.",
    "Operating margin improved on utilisation gains and lower subcontracting costs.",
    "Attrition eased further, supporting delivery quality.",
    "Management noted that demand for cost-optimisation programmes remains resilient.",
    "Discretionary project spending in North America remains a watch item.",
  ]],
  ["doc-04", ["TCS"], "2024-07-12", "transcript", "TCS: Q1 earnings call (excerpt)", [
    "Management flagged a slowdown in discretionary spending across banking and retail clients.",
    "Wage hikes will put pressure on operating margin in the coming quarter.",
    "Deal ramp-ups were delayed as clients deferred decisions amid macro uncertainty.",
    "Guidance language was cautious, with no acceleration expected before the second half.",
    "The order book remains healthy at the aggregate level.",
  ]],
  ["doc-05", ["INFY"], "2024-01-12", "filing", "Infosys: Q3 results filing", [
    "Revenue guidance was cut to a narrower, lower band.",
    "Weak demand in financial services and telecom verticals weighed on volumes.",
    "Furloughs and fewer working days created a seasonal headwind.",
    "Large deal signings were healthy, but conversion to revenue is slow.",
    "Operating margin was stable within the guided range.",
  ]],
  ["doc-06", ["INFY"], "2024-07-19", "transcript", "Infosys: Q1 earnings call (excerpt)", [
    "Management raised the lower end of revenue guidance on improving deal conversion.",
    "Generative AI programmes moved from pilots to production with several strategic clients.",
    "Large deal momentum was strong, with a record number of mega deals.",
    "Pricing pressure in vendor consolidation deals remains a risk to margin.",
    "Client spending in manufacturing remained weak.",
  ]],
  ["doc-07", ["HDFCBANK"], "2024-01-17", "filing", "HDFC Bank: Q3 results filing", [
    "Deposit mobilisation lagged loan disbursements, pushing the credit-to-deposit ratio higher after the merger.",
    "Net interest margin was under pressure as high-cost borrowings were refinanced slowly.",
    "Asset quality remained stable with gross NPA broadly unchanged.",
    "Management guided to a slower pace of lending to rebuild the deposit base.",
    "Analysts flagged the risk of further margin compression.",
  ]],
  ["doc-08", ["HDFCBANK"], "2024-07-22", "transcript", "HDFC Bank: Q1 earnings call (excerpt)", [
    "Deposit mobilisation is improving, with retail deposits growing faster than advances.",
    "Management expects margin to recover as legacy borrowings mature.",
    "Asset quality was healthy and credit costs were stable.",
    "Branch expansion continues to strengthen the low-cost deposit franchise.",
    "Near-term lending will remain measured by design.",
  ]],
  ["doc-09", ["ICICIBANK"], "2024-01-27", "filing", "ICICI Bank: Q3 results filing", [
    "Loan book expansion was strong, led by retail and business banking.",
    "Slippages remained low and provision coverage stayed robust.",
    "Return on equity improved, supported by healthy fee income.",
    "Unsecured retail lending is being monitored for early signs of stress.",
  ]],
  ["doc-10", ["ICICIBANK"], "2024-07-27", "transcript", "ICICI Bank: Q1 earnings call (excerpt)", [
    "Retail lending momentum remained strong and deposit accretion was healthy.",
    "Margin was resilient despite rising deposit costs.",
    "Management sees asset quality holding steady across segments.",
    "Digital channels drove record customer acquisition.",
    "Higher regulatory risk weights on unsecured loans are a modest headwind.",
  ]],
  ["doc-11", ["ITC"], "2024-01-30", "filing", "ITC: Q3 results filing", [
    "Cigarette volumes were stable and pricing supported segment margin.",
    "FMCG margin expanded on premiumisation and cost efficiencies.",
    "The hotels business delivered strong occupancy and record revenue per room.",
    "The agri business faced pressure from export restrictions.",
  ]],
  ["doc-12", ["ITC"], "2024-05-17", "transcript", "ITC: Q4 earnings call (excerpt)", [
    "Agri business revenue fell sharply on trade restrictions.",
    "Management flagged the risk of a tax increase on cigarettes in the next budget.",
    "Paperboard margins were under pressure from cheap imports.",
    "FMCG demand moderated in rural markets amid weak consumption.",
    "The demerger of the hotels business remains on schedule.",
  ]],
  ["doc-13", ["TATAMOTORS"], "2024-02-02", "filing", "Tata Motors: Q3 results filing", [
    "The JLR order book remains strong, led by Range Rover and Defender demand.",
    "EV volumes grew rapidly and the company holds a leading share of the domestic EV market.",
    "Net automotive debt fell on robust free cash flow.",
    "Commercial vehicle margin improved on better pricing.",
  ]],
  ["doc-14", ["TATAMOTORS"], "2024-08-02", "transcript", "Tata Motors: Q1 earnings call (excerpt)", [
    "Commercial vehicle demand slowed sharply as infrastructure spending paused around the elections.",
    "JLR flagged supply-chain risk from an aluminium supplier disruption.",
    "Passenger vehicle inventory at dealers is elevated, putting pressure on pricing.",
    "Management was cautious on near-term EV demand as competition intensifies.",
    "The JLR order book is normalising from record levels.",
  ]],
  ["doc-15", ["TATAMOTORS", "ITC"], "2024-03-15", "note", "Flow note: foreign investors rotate from autos to defensives", [
    "Foreign investors trimmed auto exposure after a sharp run-up, citing valuation risk.",
    "Tata Motors saw the largest outflows within the auto basket.",
    "Consumer defensives such as ITC attracted steady inflows on stable earnings visibility.",
    "Rotation flows can reverse quickly and are not a fundamental signal.",
  ]],
  ["doc-16", ["TCS", "INFY"], "2024-06-07", "note", "Sector note: Indian IT services demand check", [
    "Channel checks point to weak discretionary demand from US banking clients.",
    "Vendor consolidation creates pricing pressure but favours scale players such as TCS and Infosys.",
    "Expect a slow recovery, with acceleration unlikely before the second half.",
    "AI services demand is growing but remains small relative to legacy work.",
  ]],
];

function docMarkdown(spec: (typeof DOC_SPECS)[number]) {
  const [id, tickers, date, type, title, lines] = spec;
  return [
    "---",
    `id: ${id}`,
    `tickers: ${tickers.join(", ")}`,
    `date: ${date}`,
    `type: ${type}`,
    `title: ${title}`,
    "---",
    `# ${title}`,
    "",
    `> Synthetic document generated for the V-Finance demo (seed ${SEED}). Not a real ${type}.`,
    "",
    lines[0],
    "",
    lines[1],
    "",
    ...lines.slice(2).map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function generateProfiles(): Record<ProfileName, Profile> {
  return {
    Conservative: {
      label: "Conservative",
      description: "Capital preservation. Low drawdown tolerance, prefers documented fundamentals over price action.",
      riskTolerance: "low",
      horizon: "long",
      holdings: { HDFCBANK: 0.4, ITC: 0.25, TCS: 0.2, ICICIBANK: 0.15 },
      watchlist: ["HDFCBANK", "ITC", "TCS", "SBIN"],
      maxPositionWeight: 0.25,
      maxVolatility: 0.28,
      stanceThreshold: 0.35,
      agentWeights: { MomentumAgent: 0.7, VolumeAnomalyAgent: 0.5, SentimentAgent: 1.0, FilingsRAGAgent: 1.4 },
    },
    Moderate: {
      label: "Moderate",
      description: "Balanced growth over a medium horizon. Equal weight on price, flow, news and filings.",
      riskTolerance: "medium",
      horizon: "medium",
      holdings: { RELIANCE: 0.22, HDFCBANK: 0.2, INFY: 0.18, TATAMOTORS: 0.15, ICICIBANK: 0.15, ITC: 0.1 },
      watchlist: ["RELIANCE", "INFY", "TATAMOTORS", "SBIN"],
      maxPositionWeight: 0.3,
      maxVolatility: 0.4,
      stanceThreshold: 0.25,
      agentWeights: { MomentumAgent: 1.0, VolumeAnomalyAgent: 1.0, SentimentAgent: 1.0, FilingsRAGAgent: 1.1 },
    },
    Aggressive: {
      label: "Aggressive",
      description: "Short-horizon, momentum-driven. Accepts high volatility and concentrated positions.",
      riskTolerance: "high",
      horizon: "short",
      holdings: { TATAMOTORS: 0.45, INFY: 0.2, RELIANCE: 0.2, SBIN: 0.15 },
      watchlist: ["TATAMOTORS", "ICICIBANK", "SBIN", "INFY"],
      maxPositionWeight: 0.5,
      maxVolatility: null,
      stanceThreshold: 0.15,
      agentWeights: { MomentumAgent: 1.4, VolumeAnomalyAgent: 1.2, SentimentAgent: 0.9, FilingsRAGAgent: 0.6 },
    },
  };
}

const writeJson = (name: string, value: unknown) =>
  fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2) + "\n");

/** Regenerates every synthetic dataset. Session logs are kept unless resetSessions is set. */
export function seedAll({ resetSessions = false } = {}) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const market = generateMarket();
  writeJson("market.json", market);
  writeJson("headlines.json", { seed: SEED, synthetic: true, data: generateHeadlines(market.dates) });
  writeJson("profiles.json", generateProfiles());
  for (const name of fs.readdirSync(DOCS_DIR)) {
    if (name.endsWith(".md")) fs.unlinkSync(path.join(DOCS_DIR, name));
  }
  for (const spec of DOC_SPECS) {
    fs.writeFileSync(path.join(DOCS_DIR, `${spec[0]}.md`), docMarkdown(spec));
  }
  if (resetSessions || !fs.existsSync(SESSIONS_FILE)) writeJson("sessions.json", { sessions: [] });
  cache = {};
  return { tickers: TICKERS.length, bars: BARS, docs: DOC_SPECS.length, from: market.dates[0], to: market.dates[BARS - 1] };
}

export function isSeeded() {
  return (
    ["market.json", "headlines.json", "profiles.json", "sessions.json"].every((f) => fs.existsSync(dataFile(f))) &&
    fs.existsSync(DOCS_DIR) &&
    fs.readdirSync(DOCS_DIR).some((f) => f.endsWith(".md"))
  );
}

// ---------------------------------------------------------------------------
// Loaders (seed lazily if /data is missing, cache per process)
// ---------------------------------------------------------------------------

let cache: { market?: MarketFile; headlines?: Record<Ticker, Headline[]>; docs?: Doc[] } = {};

function ensureData() {
  if (!isSeeded()) seedAll();
}

function readJson<T>(name: string): T {
  ensureData();
  return JSON.parse(fs.readFileSync(dataFile(name), "utf8")) as T;
}

export function getMarket() {
  cache.market ??= readJson<MarketFile>("market.json");
  return cache.market;
}

export const getDates = () => getMarket().dates;
export const getSeries = (ticker: Ticker): Bar[] => getMarket().data[ticker] ?? [];

export function getHeadlines(ticker: Ticker): Headline[] {
  cache.headlines ??= readJson<{ data: Record<Ticker, Headline[]> }>("headlines.json").data;
  return cache.headlines[ticker] ?? [];
}

export function getDocs(): Doc[] {
  if (cache.docs) return cache.docs;
  ensureData();
  cache.docs = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const raw = fs.readFileSync(path.join(DOCS_DIR, f), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const meta: Record<string, string> = {};
      for (const line of (match?.[1] ?? "").split("\n")) {
        const i = line.indexOf(":");
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return {
        id: meta.id ?? f.replace(/\.md$/, ""),
        tickers: (meta.tickers ?? "").split(",").map((t) => t.trim()).filter(Boolean) as Ticker[],
        date: meta.date ?? "1970-01-01",
        type: (meta.type ?? "note") as Doc["type"],
        title: meta.title ?? f,
        body: match?.[2] ?? raw,
      };
    });
  return cache.docs;
}

// Profiles are read fresh each time so hand edits to profiles.json show up without a restart.
export const getProfiles = () => readJson<Record<ProfileName, Profile>>("profiles.json");
