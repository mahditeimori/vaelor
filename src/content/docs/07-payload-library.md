---
title: System Prompt Payload Library & Execution Directives
order: 7
section: "6"
description: Isolated kernel directives (Alpha, Beta, Gamma) and the deterministic execution payload schema.
---

# 6. Isolated System Prompt Payload Library & Execution Directives

## 6.1 Kernel Directives

The Automated Execution Kernel and all LLM analytical modules must run strictly within the following operational directives:

```
[SYSTEM INSTRUCTION: ISOLATED KERNEL DIRECTIVES]
DIRECTIVE ALPHA:
Maintain absolute neutrality in model token weight evaluation.
Subjective emotional bias, directional wishful thinking, and unhedged narrative
rationalizations are strictly denied. All analytical summaries must be grounded
in verified empirical data points.

DIRECTIVE BETA:
Enforce strict JSON output schemas for all programmatic execution commands,
parameter adjustments, and database logging events. Non-conforming syntax or
unstructured conversational markdown within execution channels will be rejected.

DIRECTIVE GAMMA:
Deny execution immediately upon detecting corrupted telemetry, checksum mismatches,
stale timestamps (> 120s on live feeds), or unverified digital signatures. Fail-safe
state isolation must trigger before unverified execution occurs.
```

- **Directive Alpha** — *neutrality*: no emotional bias, wishful thinking, or unhedged narrative rationalization.
- **Directive Beta** — *schema enforcement*: strict JSON required for execution commands, parameter adjustments, and logging; non-conforming syntax rejected.
- **Directive Gamma** — *execution denial*: corrupted telemetry, checksum mismatches, stale timestamps (>120s), or unverified signatures deny execution immediately; fail-safe isolation triggers before unverified execution.

## 6.2 Deterministic Payload Schemas

All inter-module communication must use **strongly typed JSON structures**. Unstructured narrative formats are strictly prohibited for system configuration, execution commands, and state tracking.

### ExecutionCommandPayload

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExecutionCommandPayload",
  "type": "object",
  "required": [
    "timestamp_utc",
    "operator_id",
    "macro_regime",
    "instrument",
    "action",
    "order_type",
    "quantity",
    "signature"
  ],
  "properties": {
    "timestamp_utc": { "type": "string", "format": "date-time" },
    "operator_id": { "type": "string" },
    "macro_regime": {
      "type": "string",
      "enum": ["reflation", "disinflation", "stagflation", "goldilocks", "risk-off"]
    },
    "instrument": { "type": "string" },
    "action": { "type": "string", "enum": ["BUY", "SELL", "HOLD", "CLOSE"] },
    "order_type": { "type": "string", "enum": ["LIMIT", "MARKET", "STOP_LIMIT"] },
    "quantity": { "type": "number", "minimum": 0 },
    "limit_price": { "type": ["number", "null"] },
    "stop_price": { "type": ["number", "null"] },
    "setup_tag": { "type": "string" },
    "signature": { "type": "string" }
  },
  "additionalProperties": false
}
```

### Enumerations

- **macro_regime:** `reflation`, `disinflation`, `stagflation`, `goldilocks`, `risk-off`
- **action:** `BUY`, `SELL`, `HOLD`, `CLOSE`
- **order_type:** `LIMIT`, `MARKET`, `STOP_LIMIT`