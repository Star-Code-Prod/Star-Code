---
name: shell
description: Run POSIX shell commands safely: quoting, pipes, exit status, temp files and cleanup.
---

# Shell
- Quote every variable expansion.
- Use `set -euo pipefail` in scripts.
- Check exit status; do not parse logs when a status exists.
- Use `mktemp` and clean up.
- Avoid destructive globs; list the target first.
- Prefer the project's own scripts over hand-rolled pipelines.
