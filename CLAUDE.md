# backend — Bus Tracking API

Express + Mongoose + Socket.IO service.

---

## Session start — check claude-mem first

Before reading files or exploring the codebase, always check claude-mem for prior context on the task at hand.
This avoids re-reading files that were already analyzed in a previous session and saves tokens.

```
/mem-search <topic>
get_observations([IDs])
```

Only read files directly when claude-mem has no relevant prior context, or when you need to verify that a memory is still current.

---

## Architecture

```
src/
  controllers/
  middleware/
  models/
  routes/
  socket/
  utils/
  server.js
```

---

## Testing policy (no untested code)
- Any feature or behavior change must add unit tests for new or changed helpers and utilities.
- Any CRUD or websocket change must add or update integration tests.
- Add a new row in docs/TESTING_GUIDE.md for every changed behavior.
- Keep test:unit and test:integration green before marking work done.
