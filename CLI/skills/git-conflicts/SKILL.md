---
name: git-conflicts
description: Resolve merge/rebase conflicts by understanding both sides, preserving intent and verifying the result.
---

# Conflict resolution
1. Read `git status` and the conflict markers in each file.
2. Understand both sides: base, ours, theirs.
3. Resolve for intent, not by picking a side blindly.
4. Remove every marker; run the tests that cover the area.
5. Stage only resolved files; continue the merge/rebase.
6. Show the final diff to the user before pushing.
