---
name: workflow-migration
description: Plan and execute a safe migration of a framework, dependency, schema or API without breaking behavior. Use for upgrades, rewrites and data moves.
---

# Migration

## Establish the baseline
- Record the current versions, behavior, tests and data shape.
- Identify every consumer of the thing being migrated.
- Create a rollback point: branch, backup or reversible migration.

## Design the path
- Prefer an incremental, adapter-first migration over a big-bang rewrite.
- Define the compatibility window and the dual-read/dual-write strategy if data is involved.
- List the order: schema -> producer -> consumer -> cleanup -> delete old path.

## Execute
- Migrate one slice, run the suite, then continue. Keep the old path working until the new path is proven.
- Preserve observable behavior unless the user explicitly wants a change.
- For data, backfill in batches and verify counts and checksums.

## Close
- Remove the temporary adapter only after the new path has run cleanly.
- Update docs, changelog and rollback notes.
- Report what was verified and what remains on the old path.
