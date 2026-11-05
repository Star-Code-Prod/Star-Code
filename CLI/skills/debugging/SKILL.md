---
name: debugging
description: Diagnose a bug by reproducing it, isolating the failing layer and proving the fix with a test or command.
---

# Debugging
1. Reproduce with the exact command, input and environment. If you cannot reproduce, say what you tried.
2. Read the error and the stack from the innermost frame outward.
3. Form one falsifiable hypothesis; add a log, a test or a minimal case.
4. Change one thing, then rerun the same check.
5. Fix the cause, not the symptom. Remove debug noise.
6. Prove the fix with the failing case and the surrounding suite.
