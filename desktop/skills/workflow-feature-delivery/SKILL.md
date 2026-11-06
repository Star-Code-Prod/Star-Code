---
name: workflow-feature-delivery
description: Deliver a product feature end to end: clarify the outcome, inspect the code, plan, implement, test, review and report. Use for any non-trivial feature request.
---

# Feature delivery

## Clarify the outcome
- Restate the user-visible outcome in one sentence. Identify the surface, the data, the permissions and the definition of done.
- Ask one question only when the answer changes architecture, scope or data. Otherwise choose a sensible default and say so.
- Read the project's instructions, package scripts, relevant components and tests before writing code.

## Plan
- Name the files you expect to touch and the seam for the change.
- Prefer the smallest complete change that makes the behavior real, not scaffolding.
- If the feature spans a contract (API, database, event, file format), define the contract first and update both sides.

## Build
- Follow existing patterns and naming. Reuse components and tokens; do not add a parallel design system.
- Handle loading, empty, error, disabled and permission states where they apply.
- Update imports, types, fixtures, docs and tests in the same change.
- No placeholders, TODOs or dead buttons in the delivered work.

## Prove
- Run the project's own test/verify command and the specific failing case.
- Exercise the real path: start the app or call the endpoint, then inspect output.
- Review your own diff for unrelated edits, debug noise and secrets.

## Report
- What changed, which files, how it was verified, and what remains open. Keep it short and concrete.
