/**
 * Local smoke test for the news module (no Cloudflare needed).
 * Run: node mcp/test-news.mjs
 */
import {
  filterCalendar,
  formatEventTimes,
  syncNews,
  analyzeDay,
  customAnalysis,
  classifyEvent,
} from "./lib/news.js";

/* ---------- fake KV ---------- */
const kv = new Map();
const env = {
  AI_STATE: {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, v); },
    async list({ prefix }) {
      return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  },
};

/* ---------- sample rows in ForexFactory shape ---------- */
const rows = [
  { title: "CPI m/m", country: "USD", date: "2026-11-11T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
  { title: "Core CPI m/m", country: "USD", date: "2026-11-11T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.3%" },
  { title: "FOMC Statement", country: "USD", date: "2026-11-11T14:00:00-05:00", impact: "High", forecast: "", previous: "" },
  { title: "German ZEW Economic Sentiment", country: "EUR", date: "2026-11-11T05:00:00-05:00", impact: "Medium", forecast: "20.1", previous: "18.5" },
  { title: "Crude Oil Inventories", country: "USD", date: "2026-11-12T10:30:00-05:00", impact: "Medium", forecast: "1.2B", previous: "1.5B" },
  { title: "Retail Sales m/m", country: "USD", date: "2026-11-13T08:30:00-05:00", impact: "High", forecast: "0.4%", previous: "0.6%" },
  { title: "Some Low Impact Thing", country: "USD", date: "2026-11-13T09:00:00-05:00", impact: "Low", forecast: "1", previous: "1" },
  { title: "JPY Whatever", country: "JPY", date: "2026-11-13T01:00:00-05:00", impact: "High", forecast: "1", previous: "1" },
  { title: "Employment Change", country: "GBP", date: "2026-11-12T02:00:00-05:00", impact: "High", forecast: "120K", previous: "150K" },
];

const events = filterCalendar(rows);
console.log("filtered:", events.length, "(expect 7 — JPY + Low excluded)");
console.log("ids:", events.map((e) => e.id).join(" | "));

const t = formatEventTimes(events[0].timeIso);
console.log("times:", JSON.stringify(t, null, 1));

/* seed history ledger for CPI to exercise momentum */
kv.set("news:hist:usd-cpi-m-m-2026-11-11", JSON.stringify({
  eventKey: events[0].id, title: "CPI m/m", currency: "USD",
  points: [
    { asOf: "2026-08-12T12:30:00Z", value: 0.002, raw: "0.2%", kind: "%", forecastAtRelease: 0.003 },
    { asOf: "2026-09-11T12:30:00Z", value: 0.002, raw: "0.2%", kind: "%", forecastAtRelease: 0.002 },
    { asOf: "2026-10-14T12:30:00Z", value: 0.003, raw: "0.3%", kind: "%", forecastAtRelease: 0.002 },
  ],
}));

/* patch fetch so syncNews never hits the network in this smoke test */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes("ff_calendar_thisweek.json")) {
    return { ok: true, json: async () => rows };
  }
  return realFetch(url);
};

await syncNews(env);
const cal = JSON.parse(kv.get("news:calendar"));
console.log("calendar cached:", cal.count, "week", cal.weekStart, "→", cal.weekEnd);

const day = await analyzeDay(env, "2026-11-11");
console.log("\n=== DAY ANALYSIS 2026-11-11 ===");
console.log("events:", day.eventsScheduled, "important:", day.importantEvents);
for (const p of day.predictions) {
  console.log(`- ${p.title}: ${p.predictedOutcome} → ${p.usdBias} (${p.confidence}%) [${p.family}]`);
  console.log(`  ${p.rationale}`);
}
console.log("alignment:", JSON.stringify(day.alignment, null, 1));
console.log("summary:", day.summary);
console.log("confidence:", day.confidence);
console.log("crossAsset:", JSON.stringify(day.crossAsset));

/* custom with hypothetical actual + prompt */
const custom = await customAnalysis(env, {
  date: "2026-11-11",
  custom_prompt: "I trade XAUUSD only around CPI prints.",
  hypothetical_actual: { eventTitle: "CPI m/m", value: "0.5%" },
  target_asset: "XAUUSD",
  trading_bias_rules: "Never hold through FOMC.",
});
console.log("\n=== CUSTOM ===");
console.log("scenario:", JSON.stringify(custom.scenario));
console.log("summary:", custom.summary);
console.log("crossAsset:", JSON.stringify(custom.crossAsset));

console.log("\nclassify checks:", classifyEvent("Non-Farm Employment Change").family, "|", classifyEvent("Unemployment Claims").family, "|", classifyEvent("Fed Chair Powell Speaks").family);
console.log("ALL NEWS SMOKE TESTS DONE");
