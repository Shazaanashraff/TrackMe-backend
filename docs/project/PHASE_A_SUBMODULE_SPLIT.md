# Phase A5 Submodule Split Checklist (Docs Only)

Scope: convert each app to a submodule while keeping the root umbrella repo.

## Preconditions
- Cleanup and secrets steps are committed
- Owner has created remotes for backend, user-app, driver-app, web-admin
- Owner confirms this step is destructive-ish and approved

## Steps (High Level)
1. Convert each app folder into a git submodule pointing to its new remote.
2. Add .gitmodules at root.
3. Configure root git: push.recurseSubmodules=on-demand.
4. Verify each app can push independently, and root push works.

## Verification
- Root contains only backend/, user-app/, driver-app/, web-admin/ plus .gitmodules
- Each app has its own .git and remote
- Root push triggers submodule pushes as expected

## Commit Template
- chore(repo): convert apps to submodules
