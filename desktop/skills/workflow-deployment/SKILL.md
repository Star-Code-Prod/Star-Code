---
name: workflow-deployment
description: Prepare and run a safe deployment or release with checks, observability, rollback and a clear go/no-go. Use for shipping services, apps and packages.
---

# Deployment

## Preflight
- Confirm the artifact, version, environment, secrets and migrations.
- Run the full test/build and inspect the diff since the last deploy.
- Check capacity, dependencies, feature flags and the rollback procedure.

## Go/no-go
- State the exact change, blast radius and rollback trigger.
- If a required check is missing, stop and say so; do not deploy on optimism.

## Deploy
- Deploy in the planned order. Watch health, error rate, latency and queue depth immediately.
- Verify with a real request and a smoke path, not just a green process.

## After
- Confirm metrics and logs; remove temporary flags after the soak window.
- Record version, time, operator and rollback point.
- If it fails, roll back first, then diagnose.
