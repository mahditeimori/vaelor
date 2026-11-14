"""Generate a MetaTrader 5 **indicator** from a rule strategy.

Why an indicator and not an EA: prop firms routinely forbid account-managing
robots. This export therefore contains no order calls at all — it draws the
signal, the entry, stop and target levels, prints the management plan and
alerts. The trader places and manages the trade manually, which is what the
firm permits.

The generated file mirrors the DSL evaluation used by the backtester (same
conditions, same stop/target rules), so the chart and the measured results
describe the same strategy.
"""

from __future__ import annotations

from .models import TF_MINUTES, Condition, ExitRule, Group, StrategyManifest


def _mql_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


OPS = {"above": 0, "below": 1, "cross_up": 2, "cross_down": 3}

COND = {
    "ema_cross": "C_EMA_CROSS",
    "sma_cross": "C_SMA_CROSS",
    "price_vs_ema": "C_PRICE_EMA",
    "price_vs_sma": "C_PRICE_SMA",
    "rsi": "C_RSI",
    "macd": "C_MACD",
    "breakout": "C_BREAK",
    "bollinger": "C_BB",
    "atr_filter": "C_ATR",
    "always": "C_ALWAYS",
}


def _condition(condition: Condition) -> str:
    kind = COND.get(condition.type)
    if kind is None:
        raise ValueError(f"condition type {condition.type!r} cannot be exported to MQL5")
    p1 = condition.fast or condition.period or condition.lookback or 0
    p2 = condition.slow or 0
    p3 = condition.period or 0
    value = condition.value if condition.value is not None else (condition.min or 0)
    op = OPS.get(condition.op or "above", 0)
    direction = 1 if condition.direction == "up" else -1 if condition.direction == "down" else 0
    side = 1 if condition.side in {"high", "upper"} else -1 if condition.side in {"low", "lower"} else 0
    mode = 1 if condition.mode == "touch" else 0
    # ema_cross / sma_cross: p1=fast, p2=slow, direction.
    # price_vs_*: p1=period, op. rsi: p1=period, v=level, op.
    # macd: p1=fast, p2=slow, p3=period, direction.
    # breakout: p1=lookback, side. bollinger: p1=period, v=mult, side, mode.
    # atr_filter: p1=period, v=min.
    if condition.type in {"ema_cross", "sma_cross"}:
        p1, p2 = condition.fast or 0, condition.slow or 0
    elif condition.type in {"price_vs_ema", "price_vs_sma"}:
        p1 = condition.period or 0
    elif condition.type == "rsi":
        p1 = condition.period or 0
    elif condition.type == "macd":
        p1, p2, p3 = condition.fast or 0, condition.slow or 0, condition.period or 0
        value = 0
    elif condition.type == "breakout":
        p1 = condition.lookback or 0
        value = 0
        mode = 0
    elif condition.type == "bollinger":
        p1 = condition.period or 0
        value = float(condition.mult or 2)
        p2 = 0
    elif condition.type == "atr_filter":
        p1 = condition.period or 0
        value = float(condition.min or 0)
        op = 0
    elif condition.type == "always":
        p1 = p2 = p3 = 0
        value = 0
        op = 0
        direction = 0
        side = 0
        mode = 0
    return f"{{{kind}, {int(p1)}, {int(p2)}, {int(p3)}, {float(value):g}, {op}, {direction}, {side}, {mode}}}"


def _array(name: str, group: Group | None) -> str:
    if group is None:
        return f"Cond {name}[];"
    conditions = group.all or group.any
    if not conditions:
        return f"Cond {name}[];"
    rows = ",\n  ".join(_condition(item) for item in conditions)
    return f"Cond {name}[] =\n{{\n  {rows}\n}};"


def _rule_text(rule: ExitRule | None) -> str:
    if rule is None:
        return "—"
    if rule.type == "atr":
        return f"{float(rule.mult or 0):g}× ATR"
    if rule.type == "pips":
        return f"{float(rule.pips or 0):g} pips"
    return f"{float(rule.pct or 0):g}% of price"


def _rule_fields(rule: ExitRule | None) -> tuple[int, float]:
    if rule is None:
        return 0, 0.0
    if rule.type == "atr":
        return 1, float(rule.mult or 0)
    if rule.type == "pips":
        return 2, float(rule.pips or 0)
    return 3, float(rule.pct or 0)


def generate_indicator(manifest: StrategyManifest) -> str:
    if manifest.runtime == "external":
        raise ValueError(
            "External MetaTrader 5 drivers place their own orders; there is no rule set "
            "to turn into an indicator."
        )
    if manifest.runtime == "python":
        raise ValueError(
            "Python on_bar strategies cannot be translated to MQL5 automatically. "
            "Export a JSON rule manifest (or publish the Python EA as an external driver)."
        )

    long_group = manifest.entryLong or (manifest.entry if manifest.direction != "short" else None)
    short_group = manifest.entryShort or (manifest.entry if manifest.direction != "long" else None)
    if long_group is None and short_group is None:
        raise ValueError("strategy has no entry rules to export")

    def group_arrays(prefix: str, group: Group | None) -> str:
        if group is None:
            return f"Cond {prefix}All[];\nCond {prefix}Any[];"
        if group.any:
            return f"Cond {prefix}All[];\n" + _array(f"{prefix}Any", group)
        return _array(f"{prefix}All", group) + f"\nCond {prefix}Any[];"

    stop_kind, stop_value = _rule_fields(manifest.stop)
    target_kind, target_value = _rule_fields(manifest.target)
    trail_kind, trail_value = _rule_fields(manifest.trail)

    risk_pct = float(manifest.risk.riskPct)
    max_lots = float(manifest.risk.maxLots or 100.0)
    trail_text = _rule_text(manifest.trail)
    management = (
        f"Move stop to entry at 1R"
        + (f"; after 1R trail by {trail_text}" if manifest.trail else "")
        + ". Never widen the stop."
    )

    return f"""//+------------------------------------------------------------------+
//| Vaelor signal indicator: {_mql_string(manifest.name)}
//| Generated from the strategy manifest (id: {_mql_string(manifest.id)})
//|
//| SIGNAL-ONLY by design: this file contains no OrderSend / CTrade call.
//| Prop-firm safe. Place and manage trades manually in MetaTrader 5.
//+------------------------------------------------------------------+
#property copyright "Vaelor Trading LLC"
#property version   "1.10"
#property description "{_mql_string(manifest.description or manifest.name)}"
#property description "Signal-only indicator: no orders are sent."
#property indicator_chart_window
#property indicator_buffers 3
#property indicator_plots   3

#property indicator_label1  "Buy signal"
#property indicator_type1   DRAW_ARROW
#property indicator_color1  clrLime
#property indicator_width1  2
#property indicator_label2  "Sell signal"
#property indicator_type2   DRAW_ARROW
#property indicator_color2  clrTomato
#property indicator_width2  2
#property indicator_label3  "Exit signal"
#property indicator_type3   DRAW_NONE

//--- inputs
input bool  InpAlerts           = true;   // Pop-up alert on a new signal
input bool  InpPush             = false;  // Also send a push notification
input bool  InpDrawLevels       = true;   // Draw entry / stop / target lines
input bool  InpShowPanel        = true;   // Show the ticket panel
input int   InpHistoryBars      = 4000;   // Bars of history used for signals
input color InpBuyColor         = clrLime;
input color InpSellColor        = clrTomato;
input color InpStopColor        = clrTomato;
input color InpTargetColor      = clrDodgerBlue;
input color InpEntryColor       = clrGold;

//--- strategy constants
#define STRAT_ID   "{_mql_string(manifest.id)}"
#define STRAT_NAME "{_mql_string(manifest.name)}"
#define STRAT_TF   "{manifest.timeframe}"
#define STRAT_TF_MINUTES {TF_MINUTES.get(manifest.timeframe, 60)}
#define STRAT_RISK {risk_pct:g}
#define STRAT_MAXLOTS {max_lots:g}

//--- condition types
#define C_ALWAYS     0
#define C_EMA_CROSS  1
#define C_SMA_CROSS  2
#define C_PRICE_EMA  3
#define C_PRICE_SMA  4
#define C_RSI        5
#define C_MACD       6
#define C_BREAK      7
#define C_BB         8
#define C_ATR        9

struct Cond
{{
  int    type;
  int    p1;
  int    p2;
  int    p3;
  double v;
  int    op;
  int    dir;
  int    side;
  int    mode;
}};

{group_arrays("Long", long_group)}

{group_arrays("Short", short_group)}

{group_arrays("Exit", manifest.exit)}

//--- stop / target rules: 1=ATR, 2=pips, 3=percent
#define STOP_KIND   {stop_kind}
#define STOP_VALUE  {stop_value:g}
#define TARGET_KIND {target_kind}
#define TARGET_VALUE {target_value:g}
#define TRAIL_KIND  {trail_kind}
#define TRAIL_VALUE {trail_value:g}

//--- buffers
double BuyBuf[];
double SellBuf[];
double ExitBuf[];

//--- handle cache
struct HandleRec
{{
  string key;
  int    handle;
}};
HandleRec g_handles[];

int CacheHandle(const string key, const int handle)
{{
  if(handle == INVALID_HANDLE) return INVALID_HANDLE;
  const int n = ArraySize(g_handles);
  ArrayResize(g_handles, n + 1);
  g_handles[n].key = key;
  g_handles[n].handle = handle;
  return handle;
}}

int FindHandle(const string key)
{{
  for(int i = ArraySize(g_handles) - 1; i >= 0; i--)
    if(g_handles[i].key == key) return g_handles[i].handle;
  return INVALID_HANDLE;
}}

int MaHandle(const int method, const int period)
{{
  const string key = StringFormat("ma|%d|%d", method, period);
  int h = FindHandle(key);
  if(h != INVALID_HANDLE) return h;
  return CacheHandle(key, iMA(_Symbol, PERIOD_CURRENT, period, 0,
                              method == 1 ? MODE_EMA : MODE_SMA, PRICE_CLOSE));
}}

int RsiHandle(const int period)
{{
  const string key = StringFormat("rsi|%d", period);
  int h = FindHandle(key);
  if(h != INVALID_HANDLE) return h;
  return CacheHandle(key, iRSI(_Symbol, PERIOD_CURRENT, period, PRICE_CLOSE));
}}

int MacdHandle(const int fast, const int slow, const int signal)
{{
  const string key = StringFormat("macd|%d|%d|%d", fast, slow, signal);
  int h = FindHandle(key);
  if(h != INVALID_HANDLE) return h;
  return CacheHandle(key, iMACD(_Symbol, PERIOD_CURRENT, fast, slow, signal, PRICE_CLOSE));
}}

int AtrHandle(const int period)
{{
  const string key = StringFormat("atr|%d", period);
  int h = FindHandle(key);
  if(h != INVALID_HANDLE) return h;
  return CacheHandle(key, iATR(_Symbol, PERIOD_CURRENT, period));
}}

int BandsHandle(const int period, const double mult)
{{
  const string key = StringFormat("bb|%d|%.3f", period, mult);
  int h = FindHandle(key);
  if(h != INVALID_HANDLE) return h;
  return CacheHandle(key, iBands(_Symbol, PERIOD_CURRENT, period, 0, mult, PRICE_CLOSE));
}}

bool BufValue(const int handle, const int buffer, const int shift, double &out)
{{
  if(handle == INVALID_HANDLE) return false;
  double tmp[];
  if(CopyBuffer(handle, buffer, shift, 1, tmp) < 1) return false;
  out = tmp[0];
  return true;
}}

double PipSize()
{{
  const double point = _Point;
  const int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
  return (digits == 3 || digits == 5) ? point * 10.0 : point;
}}

double RuleDistance(const int kind, const double value, const double price, const double atr)
{{
  if(kind == 1) return (atr > 0 ? value * atr : price * 0.005);
  if(kind == 2) return value * PipSize();
  if(kind == 3) return price * value / 100.0;
  return price * 0.005;
}}

bool Crossed(const double fastNow, const double fastPrev,
             const double slowNow, const double slowPrev, const bool up)
{{
  if(up)  return (fastPrev <= slowPrev && fastNow > slowNow);
  return (fastPrev >= slowPrev && fastNow < slowNow);
}}

bool Compare(const double current, const double previous, const int op, const double level)
{{
  if(op == 0) return current > level;
  if(op == 1) return current < level;
  if(op == 2) return (previous <= level && current > level);
  return (previous >= level && current < level);
}}

bool EvalCond(const Cond &c, const int shift)
{{
  double a1, a2, b1, b2;
  if(c.type == C_ALWAYS) return true;

  if(c.type == C_EMA_CROSS || c.type == C_SMA_CROSS)
  {{
    const int method = (c.type == C_EMA_CROSS) ? 1 : 0;
    const int fh = MaHandle(method, c.p1);
    const int sh = MaHandle(method, c.p2);
    if(!BufValue(fh, 0, shift, a1) || !BufValue(sh, 0, shift, b1)) return false;
    if(!BufValue(fh, 0, shift + 1, a2) || !BufValue(sh, 0, shift + 1, b2)) return false;
    return Crossed(a1, a2, b1, b2, c.dir == 1);
  }}

  if(c.type == C_PRICE_EMA || c.type == C_PRICE_SMA)
  {{
    const int method = (c.type == C_PRICE_EMA) ? 1 : 0;
    const int mh = MaHandle(method, c.p1);
    if(!BufValue(mh, 0, shift, b1)) return false;
    a1 = iClose(_Symbol, PERIOD_CURRENT, shift);
    if(c.op == 2 || c.op == 3)
    {{
      if(!BufValue(mh, 0, shift + 1, b2)) return false;
      a2 = iClose(_Symbol, PERIOD_CURRENT, shift + 1);
      if(c.op == 2) return (a2 <= b2 && a1 > b1);
      return (a2 >= b2 && a1 < b1);
    }}
    return (c.op == 0) ? (a1 > b1) : (a1 < b1);
  }}

  if(c.type == C_RSI)
  {{
    const int rh = RsiHandle(c.p1);
    if(!BufValue(rh, 0, shift, a1)) return false;
    if(c.op == 0) return a1 > c.v;
    if(c.op == 1) return a1 < c.v;
    if(!BufValue(rh, 0, shift + 1, a2)) return false;
    return Compare(a1, a2, c.op, c.v);
  }}

  if(c.type == C_MACD)
  {{
    const int mh = MacdHandle(c.p1, c.p2, c.p3);
    if(!BufValue(mh, 0, shift, a1) || !BufValue(mh, 1, shift, b1)) return false;
    if(!BufValue(mh, 0, shift + 1, a2) || !BufValue(mh, 1, shift + 1, b2)) return false;
    return Crossed(a1, a2, b1, b2, c.dir == 1);
  }}

  if(c.type == C_BREAK)
  {{
    if(c.p1 <= 0) return false;
    const int idx = (c.side == 1)
      ? iHighest(_Symbol, PERIOD_CURRENT, MODE_HIGH, c.p1, shift + 1)
      : iLowest(_Symbol, PERIOD_CURRENT, MODE_LOW, c.p1, shift + 1);
    if(idx < 0) return false;
    const double level = (c.side == 1)
      ? iHigh(_Symbol, PERIOD_CURRENT, idx)
      : iLow(_Symbol, PERIOD_CURRENT, idx);
    const double close1 = iClose(_Symbol, PERIOD_CURRENT, shift);
    return (c.side == 1) ? (close1 > level) : (close1 < level);
  }}

  if(c.type == C_BB)
  {{
    const int bh = BandsHandle(c.p1, c.v);
    const int buffer = (c.side == 1) ? 1 : 2;
    if(!BufValue(bh, buffer, shift, a1)) return false;
    if(c.mode == 1)
      return (c.side == 1)
        ? (iHigh(_Symbol, PERIOD_CURRENT, shift) >= a1)
        : (iLow(_Symbol, PERIOD_CURRENT, shift) <= a1);
    const double close1 = iClose(_Symbol, PERIOD_CURRENT, shift);
    return (c.side == 1) ? (close1 > a1) : (close1 < a1);
  }}

  if(c.type == C_ATR)
  {{
    const int ah = AtrHandle(c.p1);
    return BufValue(ah, 0, shift, a1) && a1 >= c.v;
  }}

  return false;
}}

bool EvalAll(const Cond &conds[], const int shift)
{{
  const int n = ArraySize(conds);
  if(n == 0) return false;
  for(int i = 0; i < n; i++)
    if(!EvalCond(conds[i], shift)) return false;
  return true;
}}

bool EvalAny(const Cond &conds[], const int shift)
{{
  const int n = ArraySize(conds);
  if(n == 0) return false;
  for(int i = 0; i < n; i++)
    if(EvalCond(conds[i], shift)) return true;
  return false;
}}

bool EvalSide(const Cond &all[], const Cond &any[], const int shift)
{{
  if(ArraySize(all) > 0) return EvalAll(all, shift);
  if(ArraySize(any) > 0) return EvalAny(any, shift);
  return false;
}}

void RemoveLevels()
{{
  ObjectsDeleteAll(0, "vaelor_sig_");
}}

void DrawLevel(const string name, const double price, const color clr, const int style,
               const datetime from, const datetime to)
{{
  if(!InpDrawLevels) return;
  const string obj = "vaelor_sig_" + name;
  if(ObjectFind(0, obj) < 0)
    ObjectCreate(0, obj, OBJ_TREND, 0, from, price, to, price);
  ObjectSetInteger(0, obj, OBJPROP_TIME, 0, from);
  ObjectSetInteger(0, obj, OBJPROP_TIME, 1, to);
  ObjectSetDouble(0, obj, OBJPROP_PRICE, 0, price);
  ObjectSetDouble(0, obj, OBJPROP_PRICE, 1, price);
  ObjectSetInteger(0, obj, OBJPROP_COLOR, clr);
  ObjectSetInteger(0, obj, OBJPROP_STYLE, style);
  ObjectSetInteger(0, obj, OBJPROP_WIDTH, 1);
  ObjectSetInteger(0, obj, OBJPROP_RAY_RIGHT, false);
  ObjectSetString(0, obj, OBJPROP_TEXT, StringFormat("%s %s", name, DoubleToString(price, _Digits)));
}}

int OnInit()
{{
  SetIndexBuffer(0, BuyBuf, INDICATOR_DATA);
  SetIndexBuffer(1, SellBuf, INDICATOR_DATA);
  SetIndexBuffer(2, ExitBuf, INDICATOR_DATA);
  PlotIndexSetInteger(0, PLOT_ARROW, 233);
  PlotIndexSetInteger(1, PLOT_ARROW, 234);
  PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, EMPTY_VALUE);
  PlotIndexSetDouble(1, PLOT_EMPTY_VALUE, EMPTY_VALUE);
  PlotIndexSetInteger(0, PLOT_LINE_COLOR, InpBuyColor);
  PlotIndexSetInteger(1, PLOT_LINE_COLOR, InpSellColor);
  ArraySetAsSeries(BuyBuf, true);
  ArraySetAsSeries(SellBuf, true);
  ArraySetAsSeries(ExitBuf, true);
  IndicatorSetString(INDICATOR_SHORTNAME, "Vaelor · " + STRAT_NAME);
  return INIT_SUCCEEDED;
}}

void OnDeinit(const int reason)
{{
  RemoveLevels();
  Comment("");
}}

void ShowPanel(const string side, const double entry, const double sl, const double tp,
               const double lots, const double rr, const datetime signalTime)
{{
  if(!InpShowPanel) return;
  const string tfNote = (PeriodSeconds(PERIOD_CURRENT) != STRAT_TF_MINUTES * 60)
    ? "\\nChart timeframe differs from the strategy (" + STRAT_TF + ")."
    : "";
  Comment(StringFormat(
    "VAELOR · %s\\n"
    "%s %s · %s\\n"
    "Signal bar: %s\\n"
    "Entry %s   Stop %s   Target %s\\n"
    "Suggested %.2f lots · %.1f%% risk · %s\\n"
    "Management: move to breakeven at 1R, then follow the plan.\\n"
    "Signal-only indicator: no order is sent to the broker.%s",
    STRAT_NAME, side, _Symbol, EnumToString(_Period),
    TimeToString(signalTime, TIME_DATE | TIME_MINUTES),
    DoubleToString(entry, _Digits), DoubleToString(sl, _Digits),
    (tp > 0 ? DoubleToString(tp, _Digits) : "exit rule"),
    lots, STRAT_RISK, (rr > 0 ? DoubleToString(rr, 2) + "R" : "—"), tfNote));
}}

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{{
  if(rates_total < 15) return 0;

  // Evaluate the last CLOSED bar (shift 1) once per bar.
  static datetime lastSignalBar = 0;
  const datetime barTime = time[rates_total - 2];
  if(barTime == lastSignalBar) return rates_total;

  const int shift = 1;
  const bool longSignal  = EvalSide(LongAll,  LongAny,  shift);
  const bool shortSignal = EvalSide(ShortAll, ShortAny, shift);
  const bool exitSignal  = EvalSide(ExitAll,  ExitAny,  shift);

  if(exitSignal)
  {{
    ExitBuf[shift] = close[rates_total - 2];
    if(InpAlerts) Alert(STRAT_NAME, ": exit rule fired on ", _Symbol, " ", EnumToString(_Period));
  }}

  if(!longSignal && !shortSignal) return rates_total;
  lastSignalBar = barTime;

  const bool isBuy = longSignal;
  double atrValue = 0;
  BufValue(AtrHandle(14), 0, shift, atrValue);

  const double entry = close[rates_total - 2];
  const double stopDistance = RuleDistance(STOP_KIND, STOP_VALUE, entry, atrValue);
  double targetDistance = 0;
  if(TARGET_KIND > 0) targetDistance = RuleDistance(TARGET_KIND, TARGET_VALUE, entry, atrValue);

  const double sl = isBuy ? entry - stopDistance : entry + stopDistance;
  const double tp = (targetDistance > 0)
    ? (isBuy ? entry + targetDistance : entry - targetDistance) : 0;
  const double rr = (targetDistance > 0 && stopDistance > 0) ? targetDistance / stopDistance : 0;

  const double contract = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE);
  const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
  double lots = 0.01;
  if(stopDistance > 0 && contract > 0)
    lots = equity * STRAT_RISK / 100.0 / (stopDistance * contract);
  const double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
  if(step > 0) lots = MathFloor(lots / step) * step;
  lots = MathMax(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), MathMin(lots, STRAT_MAXLOTS));

  const double offset = (atrValue > 0 ? atrValue * 0.5 : stopDistance * 0.2);
  if(isBuy) BuyBuf[shift]  = low[rates_total - 2] - offset;
  else      SellBuf[shift] = high[rates_total - 2] + offset;

  const datetime from = barTime;
  const datetime to = barTime + PeriodSeconds(PERIOD_CURRENT) * 12;
  RemoveLevels();
  DrawLevel("entry", entry,
            isBuy ? InpBuyColor : InpSellColor, STYLE_SOLID, from, to);
  DrawLevel("stop", sl, InpStopColor, STYLE_DOT, from, to);
  if(tp > 0) DrawLevel("target", tp, InpTargetColor, STYLE_DASH, from, to);

  ShowPanel(isBuy ? "BUY" : "SELL", entry, sl, tp, lots, rr, barTime);

  if(InpAlerts)
  {{
    Alert(STRAT_NAME, ": ", (isBuy ? "BUY " : "SELL "), _Symbol, " ", EnumToString(_Period),
          " entry ", DoubleToString(entry, _Digits),
          " stop ", DoubleToString(sl, _Digits),
          (tp > 0 ? " target " + DoubleToString(tp, _Digits) : " target: exit rule"));
    if(InpPush)
      SendNotification(STRAT_NAME + " " + (isBuy ? "BUY " : "SELL ") + _Symbol +
                       " entry " + DoubleToString(entry, _Digits) +
                       " SL " + DoubleToString(sl, _Digits));
  }}

  return rates_total;
}}
//+------------------------------------------------------------------+
//| Management plan (from the strategy rules)
//| {_mql_string(management)}
//+------------------------------------------------------------------+
"""
