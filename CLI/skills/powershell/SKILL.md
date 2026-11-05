---
name: powershell
description: Use PowerShell correctly on Windows: paths, quoting, pipelines, exit codes and native-command pitfalls.
---

# PowerShell
- Quote paths with spaces; use single quotes for literals.
- Prefer cmdlets and `Get-ChildItem` over shell aliases.
- Check `$LASTEXITCODE` after native commands.
- Use `-ErrorAction Stop` when a failure must stop the script.
- Avoid `cd` in a script; pass `-Path`/`-WorkingDirectory`.
- Test the command before putting it in a loop.
