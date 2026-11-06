---
name: workflow-sql-analysis
description: Answer a data question with correct SQL: clarify the grain, inspect the schema, write a readable query, validate the result and explain assumptions. Use for analytics and reporting questions.
---

# SQL analysis

## Clarify
- Restate the question as a metric, a population and a time window.
- Confirm the table grain before joining; state fan-out and duplicate risks.
- Check null and timezone semantics.

## Explore
- Inspect schemas, keys, indexes and a few representative rows.
- Start with a count and distinct check before trusting a join.

## Query
- Use explicit columns, readable CTEs and comments for business rules.
- Filter early, aggregate at the right grain, and avoid SELECT * in production.
- Make the result deterministic with ordering when presenting top-N.

## Validate
- Run a smaller sanity slice and a total/row-count check.
- Test an edge case: empty period, null key, duplicate id.
- State assumptions and what the data cannot answer.

## Explain
- Give the answer first, then the query and the caveats. Do not imply a causal claim from a correlation.
