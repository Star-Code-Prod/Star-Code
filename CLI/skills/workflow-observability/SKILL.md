---
name: workflow-observability
description: Make a system observable: structured logs, metrics, traces, dashboards, alerts, SLOs and runbooks. Use for reliability and debugging work.
---

# Observability

## Define
- Name the user journey and the SLO: availability, latency, freshness or correctness.
- Choose the few signals that explain failure, not every possible metric.

## Instrument
- Structured logs with request id, user/tenant id (no secrets), operation and outcome.
- Metrics at the boundary; traces across service calls.
- Add error budgets and alert on symptoms users feel, not on every CPU spike.

## Dashboard
- One row for SLO and error budget; one for traffic, errors, latency and saturation; one for dependencies and queues.
- Include deploy markers and a link to the runbook.

## Runbook
- Detection, first checks, mitigation, escalation and rollback.
- Test the alert and the runbook, not just the happy path.
