# Phase A Secrets Checklist (Docs Only)

Scope: untrack secrets and provide .env.example files per app.

## Tasks
- git rm --cached backend/.env and user-app/.env
- Add .env to each app .gitignore
- Ensure backend/.env.example exists and lists all required keys
- Create user-app/.env.example with required keys
- Note that credentials are rotated by owner (no history rewrite)

## Verification
- .env files are untracked but still present locally
- .env.example files include every required key
- Docs mention rotation responsibility and no history rewrite

## Commit Template
- chore(secrets): untrack backend and user-app env files
- chore(secrets): add .env examples and gitignore entries
