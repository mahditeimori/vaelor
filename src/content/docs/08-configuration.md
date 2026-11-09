---
title: System Customization Hooks & Runtime Configuration
order: 8
section: "7"
description: Operator-adjustable parameters, thresholds and runtime configuration hooks.
---

# 7. System Customization Hooks & Runtime Configuration

## 7.1 Operator-Adjustable Parameters

Authorized operators may modify specific system thresholds via runtime configuration hooks **without altering underlying engine logic**:

| Customization Hook | Default Value | Valid Configurable Range | Operational Purpose |
|---|---|---|---|
| **Watchlist Capacity** | 10 instruments | 3 to 25 instruments | Size of ranked pre-market focus universe |
| **Macro Indicator Weights** | Equal-weight model | Normalized `w_i ∈ [0,1]`, `Σ w_i = 1.0` | Relative weight per indicator in regime synthesis |
| **Scorecard Metrics** | §3.4 standard defaults | User-defined selection array | Adds/removes scoring dimensions in periodic reports |
| **Alert Sensitivity** | 1.0 (Standard) | 0.1 to 3.0 per alert type | Calibrates trigger sensitivities independently across modules |
| **Historical Baseline Window** | 8 weeks | 4 to 26 weeks | Trailing lookback for personal performance scoring |
| **OI Shock Threshold** | ±5.0% | ±1.0% to ±15.0% | Session-over-session OI change flag threshold |
| **COT Extreme Threshold** | ±2.0 Z-score | ±1.5 to ±3.0 Z-score | Statistical threshold for positioning extremes |

## 7.2 Document Audit & Ratification Record

This document unifies the Master Operating Manual with the complete Configuration Specification V2 (including Futures Market Structure and ICT Macro modules). It establishes the formal operating baseline for Trading LLC.

- **Document Version:** 2.0.1
- **Standard Identifier:** `TLLC-OPS-V2.0.1-FINAL`
- **System Authority:** Primary Systems Operator, Risk Controller, Automated Execution Kernel
- **Ratification Status:** Confirmed and ready for operational deployment.

## Company Code (Reference)

The full structured specification — departments, role roster, reporting hierarchy, formulas, workflows, and UI architecture — is available as machine-readable data in the [Company Code](/docs/company-code) reference, generated from `trading_llc_company_code.json`.