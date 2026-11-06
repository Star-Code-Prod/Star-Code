---
name: workflow-incident-response
description: Respond to a production incident: stabilize first, gather evidence, find the cause, recover and write the postmortem. Use for outages, errors and data incidents.
---

# Incident response

## Stabilize
- State impact, start time and current severity.
- Stop the bleeding: rollback, feature flag, scale, failover or disable the failing path.
- Do not change multiple hypotheses at once; record every action with a timestamp.

## Diagnose
- Check recent deploys, config changes, dependency updates, traffic and resource saturation.
- Use logs, metrics and traces to find the first failing boundary, not the loudest symptom.
- Preserve evidence before cleaning up.

## Recover
- Restore service, then verify with real requests and key metrics.
- Watch for the second failure: queues, retries, stale caches, partial writes.

## Learn
- Write a blameless timeline: impact, detection, cause, contributing factors, recovery.
- Add one preventive action with an owner and a test/alert.
- Do not claim root cause without evidence; say "contributing factor" when that is what you have.
