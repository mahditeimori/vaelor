/**
 * Strategy registry, signal queue and measured performance.
 *
 * This is the collaboration layer between AI agents (MCP), the website and the
 * local MT5 execution bridge:
 *
 *   AI agent ──register_strategy/submit_signal──▶ Worker KV ──GET /api/...──▶ bridge
 *   bridge ──POST /api/performance──────────────▶ Worker KV ──GET──▶ website/MCP
 *
 * Rules that are enforced here, not in the UI:
 *   - a published strategy is always created disabled — an agent cannot turn on
 *     trading by publishing a manifest;
 *   - signals are queued as `pending` and only the bridge (the owner's machine)
 *     can approve or reject them;
 *   - success rates come from the bridge's measured results (backtest or live
 *     deals), never from a number supplied by the author.
 */

const K = {
  strategy: (id) => `trade:strategy:${id}`,
  strategyIndex: 'trade:index:strategies',
  signal: (id) => `trade:signal:${id}`,
  signalIndex: 'trade:index:signals',
  performance: 'trade:performance',
};

const MAX_STRATEGIES = 500;
const MAX_SIGNALS = 500;
const SLUG = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SYMBOL = /^[A-Z0-9._#-]{2,20}$/;
const TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);
const SIDES = new Set(['buy', 'sell']);
const SIGNAL_STATES = new Set(['pending', 'approved', 'executed', 'rejected', 'expired', 'cancelled']);

function kv(env) {
  if (!env?.AI_STATE) throw new Error('AI_STATE KV namespace is not bound');
  return env.AI_STATE;
}

async function readJson(env, key, fallback) {
  const raw = await kv(env).get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(env, key, value) {
  await kv(env).put(key, JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function slug(raw, fallback) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return SLUG.test(text) ? text : fallback;
}

function randomId(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ================= validation ================= */

/**
 * Required parameters per condition type. Mirrors the execution engine's own
 * validator (mt5-bridge/app/strategies.py) so an AI author is told about a bad
 * manifest at publish time instead of the owner silently losing the strategy
 * when the bridge tries to import it.
 */
const CONDITION_FIELDS = {
  ema_cross: ['fast', 'slow', 'direction'],
  sma_cross: ['fast', 'slow', 'direction'],
  price_vs_ema: ['period', 'op'],
  price_vs_sma: ['period', 'op'],
  rsi: ['period', 'op', 'value'],
  macd: ['fast', 'slow', 'period', 'direction'],
  breakout: ['lookback', 'side'],
  bollinger: ['period', 'mult', 'side'],
  atr_filter: ['period', 'min'],
  always: [],
};

const COMPARE_OPS = new Set(['above', 'below', 'cross_up', 'cross_down']);
const DIRECTIONS = new Set(['up', 'down']);
const BOLLINGER_SIDES = new Set(['high', 'low']);
const BREAKOUT_SIDES = new Set(['high', 'low']);

function validateCondition(clause, label, errors) {
  if (!clause || typeof clause !== 'object') {
    errors.push(`${label} must be an object`);
    return;
  }
  const type = String(clause.type ?? '');
  if (!type) {
    errors.push(`${label}.type is required`);
    return;
  }
  if (!(type in CONDITION_FIELDS)) {
    errors.push(
      `${label}.type "${type}" is not supported (use ${Object.keys(CONDITION_FIELDS).join(', ')})`,
    );
    return;
  }
  for (const field of CONDITION_FIELDS[type]) {
    if (clause[field] == null) errors.push(`${label}: ${type} needs "${field}"`);
  }
  if (clause.op != null && !COMPARE_OPS.has(String(clause.op))) {
    errors.push(`${label}: op must be above, below, cross_up or cross_down`);
  }
  if (clause.direction != null && !DIRECTIONS.has(String(clause.direction))) {
    errors.push(`${label}: direction must be up or down`);
  }
  if (type === 'breakout' && clause.side != null && !BREAKOUT_SIDES.has(String(clause.side))) {
    errors.push(`${label}: side must be high or low`);
  }
  if (type === 'bollinger' && clause.side != null && !BOLLINGER_SIDES.has(String(clause.side))) {
    errors.push(`${label}: side must be high or low`);
  }
  if (type === 'rsi' && clause.value != null) {
    const v = Number(clause.value);
    if (!(v >= 0 && v <= 100)) errors.push(`${label}: rsi value must be between 0 and 100`);
  }
  if (
    (type === 'ema_cross' || type === 'sma_cross' || type === 'macd') &&
    clause.fast != null &&
    clause.slow != null &&
    Number(clause.fast) >= Number(clause.slow)
  ) {
    errors.push(`${label}: fast must be smaller than slow`);
  }
  if (type === 'breakout' && clause.lookback != null && Number(clause.lookback) < 2) {
    errors.push(`${label}: breakout lookback must be >= 2`);
  }
  for (const field of ['fast', 'slow', 'period', 'lookback']) {
    const value = clause[field];
    if (value == null) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${label}: ${field} must be positive`);
    if (n > 500) errors.push(`${label}: ${field} is unreasonably large (max 500)`);
  }
}

function validateGroup(group, label, errors) {
  if (group == null) return;
  if (typeof group !== 'object') {
    errors.push(`${label} must be an object with "all" or "any"`);
    return;
  }
  const clauses = group.all ?? group.any;
  if (!Array.isArray(clauses) || clauses.length === 0) {
    errors.push(`${label} needs a non-empty "all" or "any" array`);
    return;
  }
  if (group.all && group.any) errors.push(`${label}: use either "all" or "any", not both`);
  clauses.forEach((clause, i) => validateCondition(clause, `${label}[${i}]`, errors));
}

export function validateStrategy(raw) {
  const errors = [];
  const manifest = { ...(raw ?? {}) };

  manifest.id = slug(manifest.id ?? manifest.name, randomId('strat-'));
  manifest.name = String(manifest.name ?? '').trim().slice(0, 80);
  if (manifest.name.length < 2) errors.push('name is required (2-80 characters)');

  manifest.author = String(manifest.author ?? 'unknown').trim().slice(0, 80) || 'unknown';
  manifest.description = String(manifest.description ?? '').trim().slice(0, 600);

  manifest.symbols = Array.isArray(manifest.symbols)
    ? [...new Set(manifest.symbols.map((s) => String(s).trim().toUpperCase()))]
    : [];
  if (manifest.symbols.length === 0) errors.push('symbols must list at least one instrument');
  if (manifest.symbols.length > 8) errors.push('at most 8 symbols per strategy');
  manifest.symbols.forEach((s) => {
    if (!SYMBOL.test(s)) errors.push(`invalid symbol: ${s}`);
  });

  manifest.timeframe = String(manifest.timeframe ?? 'H1').toUpperCase();
  if (!TIMEFRAMES.has(manifest.timeframe)) {
    errors.push(`timeframe must be one of ${[...TIMEFRAMES].join(', ')}`);
  }

  manifest.direction = String(manifest.direction ?? 'both').toLowerCase();
  if (!['long', 'short', 'both'].includes(manifest.direction)) {
    errors.push('direction must be long, short or both');
  }

  validateGroup(manifest.entry, 'entry', errors);
  validateGroup(manifest.entryLong, 'entryLong', errors);
  validateGroup(manifest.entryShort, 'entryShort', errors);
  validateGroup(manifest.exit, 'exit', errors);

  if (!manifest.entry && !manifest.entryLong && !manifest.entryShort) {
    errors.push('provide entry, entryLong or entryShort');
  }
  if (manifest.entry && manifest.direction === 'both') {
    errors.push('direction=both needs entryLong and entryShort (or set direction)');
  }

  for (const key of ['stop', 'target', 'trail']) {
    const rule = manifest[key];
    if (rule == null) continue;
    if (!['atr', 'pips', 'percent'].includes(rule.type)) {
      errors.push(`${key}.type must be atr, pips or percent`);
      continue;
    }
    if (rule.type === 'atr' && !(rule.mult > 0)) errors.push(`${key}.mult is required for atr`);
    if (rule.type === 'pips' && !(rule.pips > 0)) errors.push(`${key}.pips is required for pips`);
    if (rule.type === 'percent' && !(rule.pct > 0)) errors.push(`${key}.pct is required for percent`);
  }

  const risk = manifest.risk ?? {};
  manifest.risk = {
    riskPct: Math.min(Math.max(Number(risk.riskPct ?? 1), 0.05), 10),
    maxPositions: Math.min(Math.max(Number(risk.maxPositions ?? 1), 1), 10),
    ...(risk.maxLots ? { maxLots: Math.min(Math.max(Number(risk.maxLots), 0.01), 100) } : {}),
  };
  manifest.tags = Array.isArray(manifest.tags)
    ? manifest.tags.map((t) => String(t).slice(0, 24)).slice(0, 12)
    : [];
  manifest.version = Math.max(1, Number(manifest.version ?? 1));
  manifest.enabled = false;
  manifest.autoExecute = false;

  delete manifest.performance;
  delete manifest.source;
  return { ok: errors.length === 0, manifest, errors };
}

/* ================= strategies ================= */

async function readIndex(env, key, cap) {
  const ids = await readJson(env, key, []);
  return Array.isArray(ids) ? ids.slice(0, cap) : [];
}

async function pushIndex(env, key, id, cap) {
  const ids = (await readIndex(env, key, cap)).filter((x) => x !== id);
  ids.unshift(id);
  await writeJson(env, key, ids.slice(0, cap));
}

export async function upsertStrategy(env, raw, { source = 'ai' } = {}) {
  const { ok, manifest, errors } = validateStrategy(raw);
  if (!ok) return { ok: false, errors };

  const existing = await readJson(env, K.strategy(manifest.id), null);
  const createdAt = existing?.createdAt ?? manifest.createdAt ?? nowIso();
  const record = {
    ...manifest,
    // A published strategy is inert until the owner enables it locally.
    enabled: false,
    autoExecute: false,
    source,
    createdAt,
    updatedAt: nowIso(),
    ...(existing ? { previousVersion: existing.version } : {}),
  };
  if (existing) record.version = Math.max(existing.version ?? 1, manifest.version ?? 1) + 1;

  await writeJson(env, K.strategy(record.id), record);
  await pushIndex(env, K.strategyIndex, record.id, MAX_STRATEGIES);
  return { ok: true, strategy: record, created: !existing };
}

export async function retireStrategy(env, id) {
  const record = await readJson(env, K.strategy(id), null);
  if (!record) return { ok: false, error: 'strategy not found' };
  record.enabled = false;
  record.autoExecute = false;
  record.retired = true;
  record.updatedAt = nowIso();
  await writeJson(env, K.strategy(id), record);
  return { ok: true, strategy: record };
}

export async function getStrategy(env, id) {
  const record = await readJson(env, K.strategy(slug(id, '')), null);
  if (!record) return null;
  const performance = await readPerformance(env);
  return { ...record, performance: performance.byId?.[record.id] ?? null };
}

export async function listStrategies(env, { includeRetired = false } = {}) {
  const ids = await readIndex(env, K.strategyIndex, MAX_STRATEGIES);
  const strategies = [];
  for (const id of ids) {
    const record = await readJson(env, K.strategy(id), null);
    if (!record) continue;
    if (record.retired && !includeRetired) continue;
    strategies.push(record);
  }
  const performance = await readPerformance(env);
  return strategies.map((s) => ({
    ...s,
    performance: performance.byId?.[s.id] ?? null,
  }));
}

/* ================= signals ================= */

export async function submitSignal(env, raw) {
  const strategyId = slug(raw?.strategyId ?? raw?.strategy_id, '');
  if (!strategyId) return { ok: false, error: 'strategyId is required' };
  const strategy = await readJson(env, K.strategy(strategyId), null);
  if (!strategy) {
    return { ok: false, error: `unknown strategy "${strategyId}" — register it first` };
  }
  if (strategy.retired) return { ok: false, error: 'strategy is retired' };

  const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
  if (!SYMBOL.test(symbol)) return { ok: false, error: 'symbol is required (e.g. XAUUSD)' };

  const side = String(raw?.side ?? '').toLowerCase();
  if (!SIDES.has(side)) return { ok: false, error: 'side must be buy or sell' };

  const numeric = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const signal = {
    id: randomId('sig_'),
    strategyId,
    strategyName: strategy.name,
    symbol,
    side,
    entry: numeric(raw?.entry),
    sl: numeric(raw?.sl),
    tp: numeric(raw?.tp),
    confidence: Number.isFinite(Number(raw?.confidence))
      ? Math.min(Math.max(Number(raw.confidence), 0), 1)
      : null,
    note: String(raw?.note ?? '').slice(0, 400),
    timeframe: strategy.timeframe,
    status: 'pending',
    createdAt: nowIso(),
    decidedAt: null,
    decisionNote: null,
    author: String(raw?.author ?? strategy.author ?? 'ai').slice(0, 80),
  };

  await writeJson(env, K.signal(signal.id), signal);
  await pushIndex(env, K.signalIndex, signal.id, MAX_SIGNALS);
  return { ok: true, signal };
}

export async function listSignals(env, { status = null, limit = 50 } = {}) {
  const ids = await readIndex(env, K.signalIndex, MAX_SIGNALS);
  const out = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const record = await readJson(env, K.signal(id), null);
    if (!record) continue;
    if (status && record.status !== status) continue;
    out.push(record);
  }
  return out;
}

export async function setSignalStatus(env, id, status, { note = '', ticket = null, actor = 'bridge' } = {}) {
  if (!SIGNAL_STATES.has(status)) {
    return { ok: false, error: `status must be one of ${[...SIGNAL_STATES].join(', ')}` };
  }
  const record = await readJson(env, K.signal(slug(id, '')), null);
  if (!record) return { ok: false, error: 'signal not found' };
  if (record.status === status) return { ok: true, signal: record, unchanged: true };
  record.status = status;
  record.decidedAt = nowIso();
  record.decisionNote = String(note ?? '').slice(0, 400);
  record.decidedBy = actor;
  if (ticket != null) record.ticket = Number(ticket);
  await writeJson(env, K.signal(record.id), record);
  return { ok: true, signal: record };
}

/* ================= performance ================= */

export async function recordPerformance(env, payload) {
  if (!payload || !Array.isArray(payload.strategies)) {
    return { ok: false, error: 'payload must include a strategies array' };
  }
  const byId = {};
  for (const row of payload.strategies) {
    const id = slug(row?.id, '');
    if (!id) continue;
    byId[id] = {
      id,
      successRate: Number(row.successRate ?? 0),
      profitFactor: row.profitFactor == null ? null : Number(row.profitFactor),
      score: Number(row.score ?? 0),
      trades: Number(row.trades ?? 0),
      confidence: String(row.confidence ?? 'insufficient'),
      evidence: String(row.evidence ?? 'backtest'),
      maxDrawdownPct: row.maxDrawdownPct == null ? null : Number(row.maxDrawdownPct),
      expectancyR: row.expectancyR == null ? null : Number(row.expectancyR),
    };
  }
  const snapshot = {
    generatedAt: payload.generatedAt ?? nowIso(),
    receivedAt: nowIso(),
    mode: String(payload.mode ?? 'unknown'),
    overall: payload.overall ?? null,
    byId,
  };
  await writeJson(env, K.performance, snapshot);
  return { ok: true, performance: snapshot };
}

export async function readPerformance(env) {
  return (await readJson(env, K.performance, null)) ?? {
    generatedAt: null,
    mode: 'unknown',
    overall: null,
    byId: {},
  };
}

/* ================= summaries for MCP text output ================= */

export function formatStrategy(strategy) {
  const p = strategy.performance;
  const perf = p
    ? `success ${p.successRate}% · PF ${p.profitFactor ?? 'n/a'} · ${p.trades} trades · confidence ${p.confidence} (${p.evidence})`
    : 'no measured results yet';
  return [
    `${strategy.id} — ${strategy.name}`,
    `  author: ${strategy.author} · symbols: ${strategy.symbols.join(', ')} · ${strategy.timeframe} · ${strategy.direction}`,
    `  state: ${strategy.retired ? 'retired' : 'ready'} · trading: ${strategy.enabled ? 'enabled locally' : 'disabled (owner must enable in the Execution page)'}`,
    `  performance: ${perf}`,
    strategy.description ? `  ${strategy.description}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSignal(signal) {
  return [
    `${signal.id} [${signal.status}] ${signal.side.toUpperCase()} ${signal.symbol} · strategy ${signal.strategyId}`,
    `  entry ${signal.entry ?? 'market'} · sl ${signal.sl ?? '—'} · tp ${signal.tp ?? '—'} · confidence ${signal.confidence ?? '—'}`,
    `  created ${signal.createdAt}${signal.note ? ` · ${signal.note}` : ''}`,
    signal.decisionNote ? `  decision: ${signal.decisionNote} (${signal.decidedBy ?? 'bridge'})` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
