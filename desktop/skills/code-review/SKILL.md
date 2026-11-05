---
name: code-review
description: Review a diff for correctness, regressions, security, performance and missing tests, with file-level findings.
---

# Code review
- Read the diff and the surrounding code, not only the changed lines.
- Look for: wrong behavior, unhandled error, permission/auth gap, data loss, race, performance cliff, missing migration, missing test.
- Rank findings by severity; include file and line.
- Separate must-fix from suggestion.
- Check the change against the repo's conventions.
- If nothing is wrong, say what you verified; do not invent findings.
