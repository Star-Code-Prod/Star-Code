---
name: workflow-api-integration
description: Integrate a third-party or internal API: auth, contracts, errors, retries, pagination, rate limits and tests. Use when connecting a service.
---

# API integration

## Contract
- Read the real documentation and capture base URL, auth, required headers, request/response schema and limits.
- Identify pagination, idempotency, rate limits and webhook signing.
- Do not invent fields; use a captured example or the schema.

## Design
- Isolate the client behind one module with typed inputs/outputs and a normalized error type.
- Handle timeouts, retries with backoff and jitter, and 4xx vs 5xx differently.
- Keep secrets server-side; never ship a private key in the client.

## Implement and prove
- Add a fake or recorded fixture for tests; test success, 401/403, 404, 429, 5xx and timeout.
- Run one real request in a safe environment and log the status, not the secret.

## Operate
- Document rate limits, refresh behavior and failure modes. Add a health check or alert where it matters.
