---
name: refactoring
description: Refactor safely: preserve behavior, keep the diff reviewable, update every caller and verify with tests.
---

# Refactoring
1. Define the behavior that must not change.
2. Find every caller with search, not memory.
3. Make the smallest structural change; do not mix in features.
4. Update imports, types, docs and tests in the same change.
5. Run the suite after each meaningful step.
6. If a step cannot be verified, stop and say what is missing.
