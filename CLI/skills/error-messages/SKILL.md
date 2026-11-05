---
name: error-messages
description: Read a stack trace, compiler error, HTTP failure or log line systematically and map it to the owning code.
---

# Reading an error
- Copy the first error, not the last cascade.
- Identify: type, message, file:line, operation, input.
- For a stack: find the first frame in your code, then its caller.
- For HTTP: status, URL, response body, request id.
- For a compiler: the first diagnostic is usually the cause.
- Check environment first when it works elsewhere: cwd, version, env var, permissions.
- Report the cause and the evidence; do not paste the whole log.
