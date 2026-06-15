# Phase A Self-Contained Apps Checklist (Docs Only)

Scope: each app owns its README, docs, .github, CLAUDE.md, and .gitignore.

## Tasks
- Ensure each app has its own README.md
- Ensure each app has .github/copilot-instructions.md
- Ensure each app has CLAUDE.md
- Ensure each app has .gitignore
- Root should not keep these per-app files

## Verification
- No cross-app imports or references
- Each app installs and runs independently
- Docs are stored under <app>/docs/

## Commit Template
- chore(docs): add per-app README and docs index
- chore(config): add per-app .gitignore and .github
