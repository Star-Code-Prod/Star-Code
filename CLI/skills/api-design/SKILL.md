---
name: api-design
description: Design HTTP or library APIs with clear inputs, outputs, errors, versioning and idempotency.
---

# API design
- Name the resource and the action; keep paths predictable.
- Define request/response shapes and every error status.
- Decide idempotency, pagination, filtering and ordering.
- Validate input at the boundary; never trust the client.
- Version or extend without breaking existing callers.
- Document one real request and one real error response.
