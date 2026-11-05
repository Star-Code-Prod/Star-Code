---
name: fixing-tests
description: Fix a failing test by finding whether the source, the test or the environment is wrong, then prove the suite is green.
---

# Fixing a failing test
1. Run the project's own command and capture the first failure.
2. Read the test, then the code it exercises.
3. Decide: source bug, test bug, stale fixture or environment.
4. Change the smallest correct thing; never weaken a valid assertion to get green.
5. Rerun the single test, then the full suite.
6. Report what failed, what changed and the final command output.
