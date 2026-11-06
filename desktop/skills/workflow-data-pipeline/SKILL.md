---
name: workflow-data-pipeline
description: Design and verify a data pipeline: sources, schema, transforms, idempotency, backfills, quality checks and failure recovery. Use for ETL and analytics work.
---

# Data pipeline

## Define
- Name the source, destination, grain, freshness and owner.
- Write the input and output schema; identify keys and nullability.
- Decide full refresh vs incremental and how deletes are represented.

## Build
- Make each stage idempotent and replayable.
- Validate types and ranges at the boundary; quarantine bad rows instead of silently dropping them.
- Add checkpoints or a watermark for incremental loads.
- Keep transformations in reviewable steps with tests on representative rows.

## Verify
- Compare row counts and checksums against the source.
- Test duplicate runs, late data, nulls, schema drift and a failed stage.
- Document the backfill command and the rollback.

## Operate
- Add freshness and volume checks; alert on failure and on silent zero-row success.
