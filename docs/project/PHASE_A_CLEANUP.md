# Phase A Cleanup Checklist (Docs Only)

Scope: remove cruft safely, each deletion in its own commit.

## Rules
- One deletion group per commit.
- Verify nothing is referenced before deleting.
- Record deletions in PROGRESS.md.

## Planned Deletions
- split-repos/ (abandoned split with nested .git)
- debug.log
- .github/java-upgrade/**/0.log
- driver-app/.expo/
- user-app/.expo/
- web-admin/dist/
- user-app/dist/
- optimisation/ (empty)
- .agents/ (empty)
- root package-lock.json (empty/misleading)
- driver-app/src/screens/__tests__/ (empty scaffold)
- uber-move-2-cufonfonts/ (only if fonts are not imported)
- backend/scripts/diagnostic-routes-buses.js
- backend/scripts/migrate-service-types.js (remove only if migration is complete)

## Verification Before Delete
- Search for imports or references (fonts, scripts, folders).
- Confirm nothing in package.json scripts references the target.
- Confirm no docs point to deleted paths.

## Commit Template
- chore(cleanup): remove split-repos
- chore(cleanup): remove web-admin dist
- chore(cleanup): remove unused fonts
