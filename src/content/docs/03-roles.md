---
title: Role Roster, Authority Hierarchy & Communication
order: 3
section: "2"
description: Chain of command, operational roles, inter-analyzer communication and user interaction modes.
---

# 2. Role Roster, Authority Hierarchy & Inter-System Communication

## 2.1 Chain of Command & Operational Roles

Decision precedence follows a strict hierarchy to eliminate execution ambiguities:

```
+-------------------------------------------------------------+
|               Primary Systems Operator (PSO)                |
|      Full Manual Override & System Kill-Switch Authority     |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                       Risk Controller                       |
|   Boundary Enforcement, Drawdown & Circuit-Breaker Triggers |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                  Automated Execution Kernel                 |
|       High-Frequency Execution within Bounded Limits        |
+-------------------------------------------------------------+
```

### Primary Systems Operator (PSO)

Holds **sovereign administrative authority** over all system operations:

- Unilateral kill-switch controls, system pause capabilities, and manual trade override authority.
- Authorize capital scale modifications exceeding a 15% delta.
- Dual cryptographic signature for system re-arming.
- Final approval on regime synthesis calls.

*Signing authority:* `re_arm`, `capital_scale_change`

### Risk Controller

Enforces parametric **boundary enforcement**, executes **circuit-breaker cutoffs**, and monitors anomaly scores (`S_anomaly ∈ [0.0, 1.0]`):

- Trigger execution freeze when `S_anomaly > 0.85`.
- Revoke API keys and session tokens on freeze; quarantine execution kernels to offline state.
- Dispatch priority alerts to PSO.
- Dual cryptographic signature for system re-arming.

*Signing authority:* `re_arm`

### Automated Execution Kernel

Executes algorithmic orders, processes fills, and enforces automated trade logic within the parameters set by the Risk Controller and PSO:

- Sub-millisecond latency monitoring; slippage evaluation against NBBO quotes.
- Transition to hedge protection and fail-safe stop coverage on execution halt.
- **Directive Alpha:** Maintain absolute neutrality — no subjective emotional bias, wishful thinking, or unhedged narrative rationalizations.
- **Directive Beta:** Enforce strict JSON output schemas for all execution commands; non-conforming syntax rejected.
- **Directive Gamma:** Deny execution on corrupted telemetry, checksum mismatches, stale timestamps (>120s), or unverified signatures.

## 2.2 Inter-Analyzer Communication Architecture

Subsystems interact via deterministic input–output relationships:

| From | To | Data | Trigger |
|---|---|---|---|
| Macro Engine | Pre-Market Analyzer | Active **regime call** (mandatory input for scenario-probability weighting; probabilities are not independently recomputed) | Pre-session briefing generation |
| Post-Market Analyzer | Pre-Market Analyzer | Unresolved market internals and sector divergences (feed forward as open items) | Session close |
| Performance Analyst | Pre-Market Analyzer | Behavioral variance metrics — **informative warnings only** (e.g. `"Flag: sizing variance elevated this week"`) | Weekly aggregation |

Behavioral variance metrics never mutate system execution parameters without explicit, authenticated operator action.

## 2.3 User Interaction Modes & Dispatch Cadence

The system provides three operational interfaces:

| Interaction Mode | Operational Trigger | Delivery Specification |
|---|---|---|
| **Scheduled Briefing** | Time-based (pre-market open, post-market close) | Full structured output, fixed-format Markdown/report |
| **On-Demand Query** | User/Operator manual request | Scoped, contextual response (single analyzer or cross-engine) |
| **Proactive Alert** | Threshold breach (regime flip, divergence, COT shock) | Short-form push notification detailing immediate risk context |