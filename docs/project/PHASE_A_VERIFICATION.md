# Phase A Verification Checklist (Docs Only)

Use this checklist after Phase A cleanup, secrets, and self-contained steps.

## Root Layout
- Root contains only backend/, user-app/, driver-app/, web-admin/ plus .git and .gitmodules.
- Root docs/ tree has been fully distributed into per-app docs/.

## App Independence
- Each app has README.md, docs/README.md, CLAUDE.md, .github/copilot-instructions.md, and .gitignore.
- Each app installs and runs independently.
- No cross-app imports.

## Secrets
- backend/.env and user-app/.env are untracked.
- .env.example exists per app with required keys.
- .env is listed in each app's .gitignore.

## Cleanup
- split-repos/ removed.
- caches and build outputs removed.
- logs removed.
- unused fonts removed (after reference check).

## Submodule Preconditions
- Each app has its own remote ready.
- Owner confirms submodule split.
