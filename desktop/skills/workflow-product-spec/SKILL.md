---
name: workflow-product-spec
description: Write a product spec or PRD: problem, users, evidence, scope, flows, requirements, edge cases, metrics, risks and open questions. Use before building a feature.
---

# Product spec

## Problem
- State the user, the job, the current pain and the evidence.
- Separate the problem from the proposed solution.

## Scope
- Define in-scope and out-of-scope explicitly.
- List the primary flow, alternate flows and failure states.
- Write requirements as observable behavior; add acceptance criteria.

## Detail
- Cover permissions, empty/loading/error states, data retention and accessibility.
- Name the metric and the guardrail metric.
- Record dependencies, risks and open questions with owners.

## Review
- Check every requirement traces to the problem.
- Remove requirements that are implementation details unless they constrain the contract.
- Deliver inline unless the user explicitly asks for a document artifact.
