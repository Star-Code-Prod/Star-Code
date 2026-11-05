---
name: json-yaml
description: Edit JSON/YAML safely: valid syntax, schema, quoting and preserving unrelated content.
---

# JSON / YAML
- Parse before and after the edit; invalid JSON is not a text edit.
- Preserve key order and unrelated fields when possible.
- Quote strings that look like booleans/numbers in YAML.
- Validate against the project's schema if one exists.
- Do not hand-edit a lockfile; use the package manager.
- Show the diff of the changed keys.
