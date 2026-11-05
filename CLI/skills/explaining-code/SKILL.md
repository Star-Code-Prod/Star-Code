---
name: explaining-code
description: Explain how a file, module, feature or codebase works with concrete paths, call flow and evidence from the source.
---

# Explaining code
1. Locate the real entry point and read it before explaining.
2. Give the short version first: what it does and where it lives.
3. Trace the flow with concrete symbols and paths: caller -> function -> data -> side effect.
4. Call out the non-obvious part: cache, retry, permission, state, lifecycle.
5. Distinguish what you read from what you inferred. Cite paths and line numbers.
6. If the user asked "how does X work" about Pulse Harness, load the pulse-harness skill.
