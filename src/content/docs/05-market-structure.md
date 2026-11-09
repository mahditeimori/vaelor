---
title: Futures Market Structure & ICT Macro Module
order: 5
section: "4"
description: Price/search interface, Open Interest tracking, four-state engine, COT pipeline and Composite Signal Dashboard.
---

# 4. Futures Market Structure & Applied ICT Macro Module

## 4.1 Price/Search Interface & Timeframe Aggregation

- **Instrument Resolution:** Unified search resolving tickers by symbol, full asset name, or underlying cash pair. Searching `GC`, `Gold Futures`, or `XAUUSD` resolves to the GC continuous contract; `DX` or `USD Index` maps to DX futures.
- **Timeframe Aggregation Engine:** Daily, Weekly, Monthly, and Quarterly views. The system caches the daily OHLC base series and **aggregates client-side** for higher timeframes to avoid redundant data pulls.
- **Chart Rendering:** Candlestick visualization with volume histogram in a dedicated panel beneath. Volume profile is an optional, togglable overlay.

## 4.2 Open Interest (OI) Tracking & CME Settlement Integration

| Field | Ingestion Source | Ingestion Frequency |
|---|---|---|
| Daily Open Interest (GC, DX) | CME exchange daily settlement data | Daily, post-settlement (~1 day lag) |
| Session-over-Session OI Change | Derived calculation (ΔOI) | Daily post-settlement |
| OI Change Threshold Flag | User-configured parameter (Default: ±5% single-session change) | Event-driven on data ingestion |

Rendered as a **standalone panel** directly beneath price/volume to prevent scale distortion. Sessions exceeding ±5% are flagged with markers on the OI panel.

## 4.3 OI / Price Four-State Correlation Engine

| Δ Price | Δ Open Interest | Structural Interpretation |
|---|---|---|
| Up | Up | New longs entering — trend confirmation and capital expansion |
| Up | Down | Short covering — technical rally driven by liquidation; lower conviction |
| Down | Up | New shorts entering — downtrend confirmation and aggressive selling |
| Down | Down | Long liquidation — decline driven by position closing; weaker trend conviction |

The prevailing state is calculated per session and surfaced on the Composite Signal Dashboard.

## 4.4 Commitment of Traders (COT) Disaggregated Report Pipeline

1. **Source & Segmentation:** CFTC COT Disaggregated Report (futures-only or futures+options) covering Gold (GC) and US Dollar Index (DX).
2. **Category Tracking:** Commercial (hedgers/producers/merchants), Non-Commercial (large institutional speculators), and **Swap Dealers** — tracked explicitly as the closest proxy for bank balance sheet positioning.
   - *System Transparency Rule:* Swap Dealers must be labeled strictly as `"Swap Dealers (Bank Proxy)"` and never misrepresented as a verified direct bank ledger.
3. **Publication Schedule:** Every **Friday at 15:30 ET**, representing positioning from the **prior Tuesday**. High-frequency polling is prohibited.
4. **Historical Z-Score Normalization:** Rolling 3-year z-score:

   `Z_COT = (X_current − μ_3Y) / σ_3Y`

   Extremes flagged when `|Z_COT| ≥ 2.0`.

## 4.5 Applied Synthesis: Positioning at Extremes & Structural Levels

1. **Commercial Accumulation / Distribution:** When `|Z_COT| ≥ 2.0` while price tests multi-week swing highs/lows, flag potential commercial distribution (selling into speculative strength) or accumulation (buying into speculative weakness).
2. **OI Divergence as a Structural Filter:** At key reversal/continuation levels, the 4-state OI classification is a conviction filter. Price extreme + declining OI = speculative exhaustion (mean reversion); price extreme + expanding OI = aggressive continuation.
3. **COT Inflection Reference Levels:** Historical price levels where a net COT category flip occurred are marked as reference horizontals — labeled explicitly as **`COT Flip Level`** (never confused with intraday order blocks).
4. **High-Probability Reversal Criteria — all three factors required:**
   - **Factor A:** Commercial COT z-score at multi-year extreme (`|Z_COT| ≥ 2.0`).
   - **Factor B:** OI contracts into the price extreme (liquidation profile).
   - **Factor C:** Price tests a documented `COT Flip Level` or historical macro liquidity pool.

   *Deterministic Rule:* Execution bias shifts to reversal only when **all three** conditions align. No alerts from an isolated factor.

## 4.6 Composite Signal Dashboard & Alert Specifications

### Layout

| Evaluated Field | Dashboard Content |
|---|---|
| **Price / OI State** | Real-time classification tag per §4.3 |
| **Commercial Z-Score** | Trailing 3-year normalized positioning value (Z_COT) |
| **Distance to COT Flip** | Arithmetic basis-point distance to nearest historical flip zone |
| **Composite Flag** | `Aligned` (all 3 criteria) · `Watch` (2 criteria) · `None` (< 2 criteria) |

*Operational Note:* The Composite Flag indicates market condition alignment; it does **not** constitute an unhedged autonomous order command.

### Automated Alert Triggers

| Alert Type | Trigger Threshold | Dispatch Format |
|---|---|---|
| **OI Shock** | Single-session OI change ≥ user threshold (default ±5%) | Short push: Symbol, ΔOI, Direction |
| **COT Extreme** | Commercial z-score crosses limit (`|Z_COT| ≥ 2.0`) | Short push: Category, Z-score, Historical context |
| **Composite Alignment** | Dashboard flag changes to `Aligned` | Priority push: Full factor alignment matrix |
| **Structural Divergence** | New swing high/low with opposing price/OI/COT state | Cautionary push: Divergence classification |

## 4.7 Multi-Panel UI/UX Architecture & Data Attribution

### Visual Hierarchy (single-view vertical layout)

- **Panel 1 (Top):** OHLC candlestick chart with volume histogram; search bar and timeframe selectors pinned to the top header.
- **Panel 2 (Middle-Upper):** Open Interest line/bar graph with marked ±5% threshold sessions.
- **Panel 3 (Middle-Lower):** Commercial net positioning histogram (weekly COT frequency; **no artificial daily interpolation**).
- **Panel 4 (Bottom — Pinned):** Composite Signal Dashboard status bar, visible across all scrolling states.

### Data Attribution & Latency Transparency

| Data Stream | Attribution Displayed | Refresh Cadence | Data Age Rule |
|---|---|---|---|
| Price / Volume | Exchange feed vendor | Continuous / Per timeframe | Live streaming tape |
| Open Interest | CME Group Daily Settlement | Once daily post-settlement | Mandatory `"As of: [Date]"` indicator |
| COT Positioning | CFTC Disaggregated Report | Weekly (Friday 15:30 ET) | Mandatory `"Data Date: [Prior Tuesday]"` indicator |

**Integrity Directive:** COT/OI panels must show **actual data age**, never dashboard refresh time — so operators never mistake weekly positioning data for real-time order flow.