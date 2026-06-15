# Copilot Instructions — backend

## Before you start

Check claude-mem for prior context before reading files or exploring the codebase.
This avoids re-analyzing files already covered in a previous session and saves tokens.

```
/mem-search <topic>
get_observations([IDs])
```

Only read files directly when claude-mem has no relevant context, or to verify a memory is still current.

---

## Project

Express + Mongoose + Socket.IO backend for the bus-tracking system.

---

## Rules
- Preserve response shape unless a bug fix requires change.
- Keep role-gated routes consistent with middleware.

---

## Testing policy (no untested code)
- Any feature or behavior change must add unit tests for new or changed helpers and utilities.
- Any CRUD or websocket change must add or update integration tests.
- Add a new row in docs/TESTING_GUIDE.md for every changed behavior.
- Keep test:unit and test:integration green before marking work done.
