---
name: regex
description: Build and debug regular expressions with explicit anchors, escaping, examples and catastrophic-backtracking checks.
---

# Regex
- State 3 positive and 3 negative examples before writing the pattern.
- Anchor the match; escape literals.
- Prefer non-greedy or explicit character classes over `.*`.
- Test the pattern against all examples.
- Avoid nested quantifiers that can backtrack exponentially.
- If the language has a parser for the format, use it instead.
