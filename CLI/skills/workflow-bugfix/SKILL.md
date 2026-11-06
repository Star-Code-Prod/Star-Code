---
name: workflow-bugfix
description: Diagnose and fix a bug by reproducing it, isolating the layer, changing one thing and proving the fix. Use for errors, regressions and flaky behavior.
---

# Bugfix

## Reproduce
- Capture the exact command, input, environment and observed vs expected result.
- If it does not reproduce, say what you tried and ask for the missing artifact; do not guess a fix.

## Isolate
- Read the error from the innermost frame outward. Form one falsifiable hypothesis.
- Add the smallest probe: a failing test, a log, a minimal input or a diff against the last good state.
- Check whether the bug is in the data, the boundary, the state transition or the render.

## Fix
- Change one thing at a time. Fix the cause, not the symptom.
- Keep the failing case as a regression test.
- Remove debug logging and temporary files before finishing.

## Prove
- Run the failing case and the surrounding suite. Report both results.
- If the fix changes behavior elsewhere, name it.

## Report
- Root cause, the fix, the regression test and any residual risk. Do not claim a fix without a rerun.
