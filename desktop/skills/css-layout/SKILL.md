---
name: css-layout
description: Fix layout with flex/grid, spacing, overflow and responsive rules instead of magic numbers.
---

# CSS layout
- Identify the container and its sizing context first.
- Prefer flex for one axis, grid for two; avoid absolute positioning for flow.
- Check min-width:0 for flex children that must shrink.
- Test the narrow breakpoint and long content.
- Use the project's spacing/radius/font tokens.
- Remove the old rule you replaced; do not stack patches.
