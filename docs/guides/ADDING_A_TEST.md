# Adding a test — backend

Which layer to write, how to run it, and where to register it. Authoritative coverage plans:
[`../TEST_PLAN_UNIT.md`](../TEST_PLAN_UNIT.md),
[`../TEST_PLAN_INTEGRATION.md`](../TEST_PLAN_INTEGRATION.md),
[`../TEST_PLAN_E2E.md`](../TEST_PLAN_E2E.md), traceability in
[`../TESTING_GUIDE.md`](../TESTING_GUIDE.md), triggers in
[`../QA_UPDATE_TRIGGERS.md`](../QA_UPDATE_TRIGGERS.md).

**Policy:** no untested code. For this service that specifically includes **authorization failure
cases** — a passing happy path proves nothing about who else could have called it.

## Which layer?

| If you changed… | Write a… |
|---|---|
| a pure util (`utils/geo`, `roomKey`, `qrToken`, `roadSnap`) | **unit** test |
| an endpoint (path, body, status, response shape) | **integration** test |
| a guard / role / ownership rule | **integration** test asserting **403 and 401**, not just 200 |
| a Mongoose schema index or invariant | **integration** test that tries to violate it |
| a socket event, room, or its auth | **ws integration** test under `tests/integration/ws/` |

## Running

```bash
npm test                  # node --test smoke suite (tests/*.test.js)
npm run test:integration  # jest — testMatch: tests/integration/**/*.test.js
```

Jest config that matters (`jest.config.js`): `testEnvironment: node`, `testTimeout: 30000`,
**`maxWorkers: 1`** and `forceExit: true`. Integration tests share **one MongoDB**, so they run
**serially** — never add `test.concurrent`, and never assume an empty database: set up and tear
down your own fixtures. Shared helpers live in `tests/integration/db.js`.

## Integration test recipe

1. Seed only what the case needs, via `tests/integration/db.js`.
2. Hit the real route through the Express app (guards included — do **not** bypass `protect`).
3. Assert **status code first**, then body shape, then persisted state.
4. Add the negative cases in the same file: wrong role, right role + wrong owner, missing token,
   malformed body, and the concurrency retry if the endpoint has an invariant.

Existing files are the pattern to copy — e.g. `private-routes-roomkey.test.js` (crypto + lockout),
`private-routes.test.js` (membership + approval branches), `auth.test.js`,
`account-registry.test.js`, `qr-attendance.test.js`, `custom-route-road-snap.test.js`.

## WS test recipe

Under `tests/integration/ws/`. Connect with a real token, then assert that a client **without**
membership is refused `join-route` / `route:get-recent-locations` on a PRIVATE route. Socket
authorization is enforced independently of REST — test it independently too.

---

## Register it (don't skip)

1. Add the row in [`../TESTING_GUIDE.md`](../TESTING_GUIDE.md): behaviour ↔ file ↔ layer ↔ trigger.
2. Add new coverage areas to the matching `TEST_PLAN_*` doc and
   [`../project/QA_TRACEABILITY_INDEX.md`](../project/QA_TRACEABILITY_INDEX.md).
3. Keep both suites green before marking work done.
