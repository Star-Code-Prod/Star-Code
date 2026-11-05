---
name: tests
description: Write focused tests with clear setup, one behavior per test, meaningful assertions and deterministic fixtures.
---

# Writing tests
- Test behavior at the public seam, not private implementation.
- One reason to fail per test; name it after the behavior.
- Arrange / act / assert in that order.
- Use real fixtures and deterministic time/randomness.
- Cover the happy path, one boundary and one failure.
- Run the new test before and after the fix; report both.
- Prefer a small number of high-signal tests over coverage theatre.
