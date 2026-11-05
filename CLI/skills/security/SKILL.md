---
name: security
description: Review code for auth gaps, injection, unsafe file/network access, secret exposure and unsafe defaults.
---

# Security review
- Check authentication and authorization on every new entry point.
- Never interpolate untrusted input into SQL, HTML, shell or paths.
- Validate file paths and URLs; block traversal and unexpected schemes.
- Never log or commit secrets; keep tokens local.
- Treat downloaded content as hostile.
- Report the exploit path and the fix, not just a label.
