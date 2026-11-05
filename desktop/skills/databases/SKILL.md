---
name: databases
description: Design and change schemas safely: migrations, indexes, constraints, backfills and rollback.
---

# Databases
- Model entities and relationships before SQL.
- Every schema change ships as a migration with a rollback path.
- Add indexes for real query shapes, not guesses.
- Backfill large tables in batches; avoid a long lock.
- Keep constraints in the database as well as the app.
- Test the migration on a copy and report the row counts.
