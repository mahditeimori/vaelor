/** Wiring test for worker.js news additions — no Cloudflare needed. */
import worker from "./worker.js";

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

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("ff_calendar_thisweek.json")) {
    return {
      ok: true,
      json: async () => [
        { title: "CPI m/m", country: "USD", date: "2026-11-11T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
        { title: "Retail Sales m/m", country: "USD", date: "2026-11-13T08:30:00-05:00", impact: "High", forecast: "0.4%", previous: "0.6%" },
        { title: "German ZEW Economic Sentiment", country: "EUR", date: "2026-11-11T05:00:00-05:00", impact: "Medium", forecast: "20.1", previous: "18.5" },
        { title: "Low noise", country: "USD", date: "2026-11-13T09:00:00-05:00", impact: "Low", forecast: "1", previous: "1" },
      ],
    };
  }
  return realFetch(url);
};

const call = async (body) => {
  const req = new Request("https://w.test/mcp", { method: "POST", body: JSON.stringify(body) });
  const res = await worker.fetch(req, env, { waitUntil: () => {} });
  return { status: res.status, json: await res.json() };
};

let r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
console.log("initialize:", r.status, "caps:", JSON.stringify(r.json.result.capabilities));

r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
console.log("tools:", r.json.result.tools.map((t) => t.name).join(", "));

r = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_weekly_macro_news", arguments: { impact: "high" } } });
console.log("get_weekly_macro_news:\n" + r.json.result.content[0].text);

r = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "analyze_daily_news_impact", arguments: { date: "2026-11-11" } } });
console.log("\nanalyze_daily_news_impact:\n" + r.json.result.content[0].text);

r = await call({
  jsonrpc: "2.0", id: 5, method: "tools/call",
  params: { name: "custom_ai_news_analysis", arguments: { date: "2026-11-13", custom_prompt: "gold only", target_asset: "XAUUSD" } },
});
console.log("\ncustom_ai_news_analysis:\n" + r.json.result.content[0].text);

r = await call({ jsonrpc: "2.0", id: 6, method: "resources/list", params: {} });
console.log("\nresources:", r.json.result.resources.map((x) => x.uri).join(", "));

r = await call({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "news://calendar/thisweek" } });
console.log("resource read ok, bytes:", r.json.result.contents[0].text.length);

r = await call({ jsonrpc: "2.0", id: 8, method: "prompts/list", params: {} });
console.log("prompts:", r.json.result.prompts.map((p) => p.name).join(", "));

r = await call({ jsonrpc: "2.0", id: 9, method: "prompts/get", params: { name: "premarket_daily_briefing", arguments: { date: "2026-11-11" } } });
console.log("prompt preview:", r.json.result.messages[0].content.text.slice(0, 220).replace(/\n/g, " | "));

/* REST endpoints */
const rest = async (p, method = "GET", body) => {
  const req = new Request(`https://w.test${p}`, { method, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, { waitUntil: () => {} });
  return { status: res.status, json: await res.json() };
};
r = await rest("/api/news/calendar?impact=high");
console.log("\nREST calendar:", r.status, r.json.count, r.json.events?.[0]?.jalaliFa);
r = await rest("/api/news/day?date=2026-11-11");
console.log("REST day:", r.status, r.json.summary);
r = await rest("/api/news/analyze", "POST", { date: "2026-11-13", trading_bias_rules: "risk 0.5% max" });
console.log("REST analyze:", r.status, r.json.confidence, r.json.tradingBiasRules);
r = await rest("/api/news/refresh", "POST");
console.log("REST refresh:", r.status, r.json.ok, r.json.count);
r = await rest("/api/news/status");
console.log("REST status:", r.status, r.json.count, r.json.fetchedAt?.slice(0, 19));
console.log("WORKER WIRING TESTS DONE");
