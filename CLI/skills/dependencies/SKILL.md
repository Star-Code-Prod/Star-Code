---
name: dependencies
description: Add, upgrade or audit dependencies with license, size, security and lockfile discipline.
---

# Dependencies
- Prefer the standard library or an existing dependency.
- Check maintenance, license, install size and transitive risk.
- Pin through the lockfile; commit the lockfile.
- Run the audit and the full suite after upgrading.
- Remove the old package and its imports.
- Never add a dependency just to avoid ten lines of clear code.
