---
name: typescript
description: Use TypeScript types to model real states, avoid any, and keep runtime validation at boundaries.
---

# TypeScript
- Model impossible states out of existence with unions.
- Avoid `any`; use `unknown` and narrow.
- Keep public types stable and exported deliberately.
- Validate external JSON at the boundary; types do not run.
- Use discriminated unions for variants.
- Run `tsc --noEmit` and the tests.
