# Blocked commands

## RESOLVED 2026-09-10 — `npm run test:integration` runs against an in-memory Mongo
The container never needed changing. `scripts/start-mem-mongo.js` (already in the repo,
`mongodb-memory-server` already a devDependency) starts a throwaway Mongo and prints its URI:

```bash
node scripts/start-mem-mongo.js &          # prints MONGO_URI=mongodb://127.0.0.1:<port>/
MONGODB_TEST_URI="mongodb://127.0.0.1:<port>/trackme_test" npx jest
```

`tests/integration/db.js` reads `MONGODB_TEST_URI`, so nothing in the suite changes. Verified:
`tests/integration/communications.test.js` passes 16/16 this way.

**Do not** point `MONGODB_TEST_URI` at Atlas — `clearTestDb()` deletes every document in every
collection, and the dev database is shared.

Caveat: the wider integration suite is non-deterministic in this environment. The same three
suites (`auth`, `profiles`, `rider-avatar`) produced 22 then 34 failures across two identical
runs with identical code, so there is no meaningful full-suite pass baseline here yet — likely
shared-database state and the new login rate limiter accumulating across runs. Worth a separate
look; it is not caused by any one change.

---

## (original report, kept for context) 2026-09-10 — `npm run test:integration`
- **Command:** `npm run test:integration` (jest, needs Mongo on 27017 per CLAUDE.md)
- **Why blocked:** `docker inspect trackme-mongo --format '{{json .NetworkSettings.Ports}}'` →
  `{"27017/tcp":[]}` — the running container publishes no host port, and nothing else listens on
  localhost:27017 (`Test-NetConnection -ComputerName localhost -Port 27017` fails). The live
  backend on :5000 doesn't need it — it runs against the Atlas `MONGODB_URI` in `.env` — so this
  is a dev-integration-test-only gap, not a live-stack problem.
- **What was verified instead:** `npm test` (smoke, node --test) passes 3/3, unaffected (doesn't
  touch communications.js). The one integration test that asserts on the changed
  `communication:event` payload (`tests/integration/communications.test.js:139-143`) only checks
  `riderId`/array lengths, not the full event shape — read by hand, unaffected by the additive
  `text`/`sender`/`absenceStatus` fields added in `services/communications.js`.
- **Fix:** recreate the container with a published port —
  `docker rm -f trackme-mongo && docker run -d --name trackme-mongo -p 27017:27017 mongo:7` —
  or point `.env`'s integration-test Mongo URI at Atlas instead. Not done here; a product/infra
  decision, not something to guess at mid-task.
