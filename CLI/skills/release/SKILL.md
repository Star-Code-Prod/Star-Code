---
name: release
description: Prepare and ship a release: version bump, changelog/update log, verification, commit, tag and push.
---

# Release
1. Run the full verify suite.
2. Bump version in package files and lockfile.
3. Add the changelog/update-log entry at the top with the same version.
4. Confirm the in-app changelog parser will see the new version.
5. Commit with the release version; push.
6. Confirm the workflow started; report the commit and any failing gate.
Never release with a red suite or an uncommitted change you cannot explain.
