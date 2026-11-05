# Reference-model evals

Reference model: **deepseek-chat**.

The deterministic harness lives at `tools/verify-evals.mjs` and the task set at
`tools/evals/tasks.json`. It checks that the four core workflows are present
and that the system prompt advertises the tools they need.

Run the prompt contract as part of the normal suite:

```bash
npm run verify
```

Print the tasks for a live model run:

```bash
STAR_EVAL=1 node tools/verify-evals.mjs
```

Live runs should be recorded with the model, date, task id, pass/fail and the
reason. The latest run is stored in `tools/evals/results.json`.

Latest live result (2026-11-05): provider `openrouter`, model
`openrouter/free`, edit-file **PASS**, fix-test **PASS**. The intended
reference model is `deepseek-chat`; set `STAR_EVAL_PROVIDER=deepseek` and
`STAR_EVAL_KEY=…` to record that run when a key is available.

| Task | What it proves |
|---|---|
| edit-file | targeted edit without collateral changes |
| fix-test | runs the suite, fixes source, not the test |
| search-summarize | finds real occurrences and cites files/lines |
| refactor | multi-file edit, callers updated, verify suite green |

When a prompt or tool description changes, re-run the live set and compare the
pass count before shipping. The static harness is the regression gate; the live
run is the quality signal.
