---
name: workflow-codebase-onboarding
description: Understand an unfamiliar repository quickly: entry points, architecture, data flow, commands, tests, conventions and risks. Use before changing a new codebase or explaining it.
---

# Codebase onboarding

## Map
- Read README, package/config files, lockfiles, CI, docs and the top-level tree.
- Identify the runtime entry points, the request/CLI flow, storage, background work and the test commands.
- Find the three files a change usually starts in.

## Trace one slice
- Follow one real feature or request end to end: input -> validation -> core -> persistence -> output.
- Note the state owner, the boundaries and where errors are handled.
- List the conventions: naming, modules, error shape, styling, test style, migrations.

## Verify
- Run the documented install, dev, build and test commands. Record what actually works.
- Look for generated files, local services, seed data and environment variables.

## Report
- A concise architecture map, the important files, the run commands and the top risks. Answer questions from the source, not assumptions.
