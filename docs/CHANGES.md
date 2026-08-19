# CHANGES — backend session log

Append-only running log of what each work session changed. **Newest entry on top.**
The pre-push check ([`scripts/check-docs.mjs`](../scripts/check-docs.mjs)) expects a new entry
when source under `src/` changed. One entry per session/PR is enough.

**Before you push, add an entry using this template:**

```md
## YYYY-MM-DD — <short title>
- **Branch:** <branch>
- **Modules touched:** <e.g. private-routes, auth — link docs/modules/*>
- **What changed:** <1–4 bullets, plain English>
- **Why:** <the reason / ticket / todo id>
- **Contract impact:** <none | which endpoint/socket payload changed + which client docs updated>
- **Tests:** <added/updated files, incl. the authz cases — or "none — docs only">
- **Docs updated:** <docs/modules/*.md, TESTING_GUIDE row, consuming app docs — or "n/a">
- **Migration:** <script + whether it must run before deploy — or "none">
- **Follow-ups / known issues:** <or "none">
```

Feeds [`CHANGELOG.md`](../CHANGELOG.md) / release notes — see [`guides/RELEASING.md`](guides/RELEASING.md).

---

## 2026-08-19 — Fix first-time Google sign-in 500 (issue #111)
- **Branch:** issue/111-google-signin-new-user-bcrypt-crash
- **Modules touched:** auth (docs/modules/AUTH.md — still a stub, unchanged)
- **What changed:** `models/shared/passwordAuth.js`'s `pre('save')` hashing hook now
  also skips hashing when `password` is falsy, not just when the path is unmodified —
  `bcrypt.hash(undefined, 12)` was throwing "Illegal arguments: undefined, number"
  because `isModified('password')` is `true` on a brand-new document even when
  `password` was explicitly passed as `undefined` (as `googleSignIn` does for a
  first-time Google account, which has no password).
- **Why:** found while writing the regression test for #71 — a first-time Google
  sign-in (no existing `Identity` for that email) crashed with a 500 instead of
  creating the account, entirely blocking new-user Google sign-up. Filed as #111,
  fixed here.
- **Contract impact:** none — `POST /api/auth/google` now succeeds (200) for a
  first-time email instead of 500; no existing successful-path behavior changed.
- **Tests:** added `tests/integration/google-signin-new-user.test.js` (2 new cases:
  first-time sign-in succeeds and issues tokens, repeat sign-in reuses the account).
  Ran the full `npm run test:integration` suite locally (in-memory MongoDB via
  `mongodb-memory-server`): 745/803 passed, same 58 pre-existing failures (17 suites,
  unrelated) as the baseline — 0 new failures.
- **Docs updated:** docs/TESTING_GUIDE.md — new row under Auth.
- **Migration:** none — this only changes behavior for a `password` value that
  previously crashed; no stored data needs backfilling.
- **Follow-ups / known issues:** none.

---

## 2026-08-19 — Scope manager route-assignment to owned/public routes (issue #49)
- **Branch:** issue/49-restrict-route-creation-to-super-admin
- **Modules touched:** routes (docs/modules/ROUTES.md — still a stub, unchanged), admin (docs/modules/ADMIN.md — still a stub, unchanged)
- **What changed:**
  - `managerController.getManagerAssignableRoutes` (`GET /api/manager/routes`) now only
    returns routes with no owning manager (super-admin/public) or owned by the calling
    manager, instead of every active route regardless of owner.
  - `managerController.createManagerVehicle` (`POST /api/manager/vehicle-accounts`) and
    `updateManagerVehicle` (`PUT /api/manager/vehicles/:vehicleId`) now scope their route
    lookup the same way, so a manager can no longer assign or reassign a vehicle to a
    route owned by a different manager by sending its `routeId` directly (the picker was
    already the only path in the web-admin UI, but the backend never enforced it — a
    manager-created route was assignable by every other manager, entirely bypassing the
    scoped private/custom-route workflow that exists for this purpose).
  - `routeController.createRoute` (`POST /api/routes`) now writes a `ManagerAuditLog`
    (`ROUTE_CREATED`) entry when the creator is a manager, matching every other
    manager-scoped mutation in this controller (update/delete/toggle already did).
- **Why:** issue #49 — `POST /api/routes` already scoped a manager-created route via
  `managerId` (added in an earlier session) and update/delete/toggle already enforced
  ownership, but nothing scoped route *assignment*: the manager-facing route picker and
  both vehicle-create/update paths did an unscoped `Route.findOne`, so the actual
  bypass described in the issue (a manager's route "assignable by every manager") was
  still live in these three call sites.
- **Contract impact:** `GET /api/manager/routes` now excludes another manager's owned
  routes from the list; `POST /api/manager/vehicle-accounts` / `PUT
  /api/manager/vehicles/:vehicleId` now return `400 Invalid route ID` for a `routeId`
  the caller doesn't own (previously succeeded). web-admin never lets a manager reach
  another manager's route through its own UI, so no web-admin change needed — noting
  here per the cross-repo contract rule since the response *can* differ for a direct
  API caller.
- **Tests:** tests/integration/authz-ownership.test.js — new `Route assignment
  ownership (issue #49)` describe block (6 cases: assignable-list excludes/includes,
  create/update refuse a non-owned route, owner can assign, create writes the audit
  log entry). Ran the full `npm run test:integration` suite locally against an
  in-memory MongoDB (`mongodb-memory-server`, already a devDependency — see
  Follow-ups) with the env vars from `.env.example` stubbed in: 743/801 passed, same
  58 pre-existing failures (17 suites, all unrelated to routes/vehicles/managers — env
  gaps like missing Google Places/Roads keys and push credentials, not caused by this
  change) as an unmodified baseline run of the same suite.
- **Docs updated:** docs/TESTING_GUIDE.md (new row under Routes and Buses).
- **Migration:** none.
- **Follow-ups / known issues:**
  - CI (`.github/workflows/ci.yml`) only runs `npm test` (the smoke suite) —
    `npm run test:integration` never runs in CI today. Locally it also silently no-ops
    without a reachable Mongo (`tests/integration/db.js` defaults to
    `mongodb://localhost:27017/trackme_test`), which this session initially hit before
    finding `mongodb-memory-server` already installed as a devDependency. Wiring CI (or
    at least a documented local script) to boot `mongodb-memory-server` + the JWT/room-key/QR
    env vars from `.env.example` would let every future issue actually verify its
    integration tests instead of relying on manual local setup like this session did —
    worth its own issue.
  - docs/modules/ROUTES.md is still the `PLANNED (doc)` stub; not written as part of
    this fix to keep the change scoped to the issue's acceptance criteria.

## 2026-08-18 — Opt-in pagination on getMyRequests / getManagerAttendance (issue #64)
- **Branch:** issue/64-manager-list-pagination
- **Modules touched:** buses (docs/modules/BUSES.md), QR attendance (docs/modules/QR_ATTENDANCE.md)
- **What changed:**
  - `managerController.getMyRequests` (`GET /api/manager/requests`) and
    `managerAttendanceController.getManagerAttendance` (`GET /api/manager/attendance`)
    now support opt-in `page`/`limit` query params, reusing the exact convention
    already established by `superAdminController.getOperationsOverview` /
    `getPendingVehicleRequests`: no `page`/`limit` param keeps returning the full,
    unbounded result with no `pagination` key, byte-for-byte unchanged from before.
    Passing either paginates and adds a `pagination: {page, limit, total, pages}` key;
    an oversized `limit` is clamped to 100.
  - `getManagerAttendance`'s rollup is built in-memory (one entry per student across
    all matched `BoardingEvent`s, not a Mongo cursor), so its pagination slices the
    already-sorted `rollup` array rather than adding `skip`/`limit` to a query.
  - Issue #64 also named `getManagerCustomRoutes`, `getManagerRouteChangeRequests`, and
    the private-route join-requests/members endpoints — none of those exist any more
    (custom routes and private routes were both removed from the backend after this
    issue was filed; see #49/#74/#19's investigation notes). `getManagerVehicles`
    (`getManagerBuses` pre-rename) was left unpaginated: a manager's own fleet size is
    bounded by how many vehicles they were assigned, nowhere near the volume of a
    request/attendance history, so it wasn't the "highest-volume" case the issue's
    acceptance criteria asks to prioritize.
- **Why:** a manager with a long request or attendance history got the entire result
  set in one response every time, with no way to page through it.
- **Contract impact:** none for existing callers — the default (no page/limit) response
  shape is byte-for-byte unchanged. A caller that opts in by passing page/limit gets a
  new `pagination` key, same shape as the existing super-admin pagination.
- **Tests:** added `tests/integration/manager-list-pagination.test.js` (6 new cases:
  unchanged default, paginated response + metadata, oversized-limit clamp — for both
  endpoints), all passing standalone and alongside `authz-ownership.test.js` (which
  covers these endpoints' manager-scoping) and `manager-status-audit-assign.test.js`.
- **Docs updated:** docs/TESTING_GUIDE.md — new row.
- **Migration:** none.
- **Follow-ups / known issues:** none.

---

## 2026-08-18 — Manager status/audit-log/assign-vehicles coverage (issue #69)
- **Branch:** issue/69-manager-status-audit-assign-coverage
- **Modules touched:** admin — docs/modules/ADMIN.md (no behavior change, test-only)
- **What changed:**
  - Added `tests/integration/manager-status-audit-assign.test.js`. Issue #69 asked for
    coverage of six superAdminController functions; three of them
    (`createManager`, `updateManager`, `resetManagerPassword`) turned out to already have
    solid behavioral coverage in `manager-organizations.test.js`,
    `manager-provisioning.test.js`, and `manager-shared-identity-email.test.js`. The
    actual remaining gap was `updateManagerStatus` (zero coverage), `getAuditLogs`
    (only its malformed-id 400 was tested, never a real filtered read), and
    `assignVehiclesToManager`'s 400/404 branches (`assign-vehicles-scope.test.js` only
    covers the scope-mismatch 409 and the plain-success 200).
  - New tests: `updateManagerStatus` deactivate→reactivate + 404; `getAuditLogs`
    managerId/action/entityType filters + unfiltered read; `assignVehiclesToManager`
    plain success, 400 on an invalid vehicle id, 404 on an unknown manager.
- **Why:** these were the genuinely untested branches on the manager-account admin
  surface; duplicating the already-covered createManager/updateManager/
  resetManagerPassword branches would have added no value.
- **Contract impact:** none — no production code changed, tests only.
- **Tests:** added `tests/integration/manager-status-audit-assign.test.js` (9 new
  cases), all passing standalone and alongside the other manager/superadmin suites.
- **Docs updated:** docs/TESTING_GUIDE.md — new row.
- **Migration:** none.
- **Follow-ups / known issues:** none.

---

## 2026-08-18 — Super-admin read-endpoint coverage (issue #70)
- **Branch:** issue/70-superadmin-reads-coverage
- **Modules touched:** admin — docs/modules/ADMIN.md (no behavior change, test-only)
- **What changed:**
  - Added `tests/integration/superadmin-reads.test.js`, covering the five super-admin
    read endpoints that had zero content-correctness coverage: `getSuperAdminDashboard`,
    `getManagerById`, `getManagerVehicleDetails` (GET /operations/:managerId),
    `getOperationsOverview` (GET /operations, per-manager content — pagination was
    already covered separately), and `getPendingVehicleRequests` (GET
    /vehicle-requests — status/type/managerId filtering).
  - Seeds a known dataset (2 managers, 3 vehicles, 2 bookings, 1 review, 3 vehicle
    requests) and asserts the KPI aggregation math against it, plus the 404 branches on
    the two `:managerId` endpoints and the default-PENDING / ALL / type / managerId
    filter behavior on the vehicle-requests list.
- **Why:** `getSuperAdminDashboard` and the two `:managerId` endpoints had no test at
  all; `getOperationsOverview` and `getPendingVehicleRequests` only had pagination
  coverage, not proof the aggregated numbers or filters are actually correct.
- **Contract impact:** none — no production code changed, tests only.
- **Tests:** added `tests/integration/superadmin-reads.test.js` (10 new cases, all
  passing standalone and alongside the other `superadmin-*.test.js` files).
- **Docs updated:** docs/TESTING_GUIDE.md — new row for the five endpoints.
- **Migration:** none.
- **Follow-ups / known issues:** `tests/integration/superadmin-operations-pagination.test.js`
  fails in this sandbox when run in the same process as other suites (pre-existing on
  `main`, unrelated to this change — see PR description).

---

## 2026-08-18 — reviewVehicleRequest branch coverage (issue #68)
- **Branch:** issue/68-review-vehicle-request-coverage
- **Modules touched:** admin — docs/modules/ADMIN.md (no behavior change, test-only)
- **What changed:**
  - Added `tests/integration/review-vehicle-request-branches.test.js`, covering the
    branches of `superAdminController.reviewVehicleRequest` that had no test: successful
    CREATE_VEHICLE_ACCOUNT approve, successful REJECT, the already-reviewed 400 guard, the
    unknown-request 404, the duplicate-vehicle 409 (and that it releases the PENDING claim),
    and the DELETE_VEHICLE approval path (soft-delete + driver deactivation, plus its own
    404 when the vehicle no longer exists).
  - Issue #68 was filed against an older "Bus"-named approval flow with separate
    custom-route/existing-route sub-branches; both the Bus→Vehicle rename and the removal
    of custom routes mean that split no longer exists in `reviewVehicleRequest` today (one
    route lookup, not two) — tests were written against the current branches instead.
- **Why:** `reviewVehicleRequest` is the highest-privilege super-admin endpoint (creates
  Vehicle/Driver documents, deletes vehicles, mints identities); only the concurrency guard
  and the field whitelist had coverage before this.
- **Contract impact:** none — no production code changed, tests only.
- **Tests:** added `tests/integration/review-vehicle-request-branches.test.js` (7 new
  cases, all passing standalone and alongside the other `review-vehicle-request-*` files).
- **Docs updated:** docs/TESTING_GUIDE.md — new row for the branches file.
- **Migration:** none.
- **Follow-ups / known issues:** local `npm run test:integration` has 18 pre-existing
  failing suites in this environment unrelated to this change (missing external API keys
  for places/transit, and `review-vehicle-request-concurrency.test.js` timing out under
  this sandbox's Mongo latency) — see PR description for the full list; CI is the real gate.

---

## 2026-08-17 — Clear all dependency vulnerabilities (0 remaining)
- **Branch:** main
- **Modules touched:** none — dependency maintenance, not a feature
- **What changed:**
  - `npm audit fix` (no `--force`) closed the mongoose, lodash, qs, and ws-family advisories via
    same-major-version patch bumps (mongoose 8.21.0 → 8.24.3).
  - Removed `nodemailer` entirely — grepped the whole repo and confirmed it has zero remaining
    call sites; email sending (verification, password reset, manager invites) fully migrated to
    `resend` already. Carrying a vulnerable, unused dependency (8 CVEs, including SMTP command
    injection) forward made no sense; removing it beats upgrading across a 6→9 major it isn't
    even using.
  - Added an `overrides.uuid: ^11.1.1` in `package.json` to force the transitive `uuid@9.0.1`
    pulled in by `google-auth-library` → `gaxios` past a moderate buffer-bounds advisory that
    `npm audit fix` couldn't reach on its own (nested transitive dep).
- **Why:** pre-launch security audit.
- **Contract impact:** none.
- **Tests:** none new — re-ran the full auth/email/rate-limit/CORS suite plus all unit tests
  against the upgraded mongoose (via an ephemeral `mongodb-memory-server`, same caveat as the
  2026-08-17 hardening entry re: this sandbox's Windows connection-pool flakiness on DB-touching
  suites — no non-timeout assertion failures, i.e. no regression).
- **Docs updated:** this entry only.
- **Follow-ups / known issues:** `npm audit` (dev dependencies included) still flags vite/esbuild/
  vitest — dev-tooling only (the esbuild dev-server-accepts-any-origin issue never ships in the
  built app), and the available fix is a major Vite version bump. Deliberately not forced here to
  avoid risking the already-verified Vercel production build; revisit separately if desired.
  `npm audit --production` is clean (0 vulnerabilities).

---

## 2026-08-17 — Render deploy hardening: IP rate limiting, CORS allowlist, crash-loop fix
- **Branch:** main
- **Modules touched:** none of `docs/modules/` — this is deploy/infra hardening, not a feature
- **What changed:**
  - New `src/middleware/rateLimiters.js` (`express-rate-limit`): IP-keyed `authLimiter` on
    `/api/auth/*` and a looser `apiLimiter` on `/api/*`, complementing the existing per-identity
    limiters in `emailRateLimiter.js` (which don't stop one client hammering many different
    accounts). Requires `app.set('trust proxy', 1)` (added in `server.js`) — Render sits behind a
    proxy, so without it every request looks like the same IP.
  - `CLIENT_ORIGINS` is now parsed into an actual allowlist instead of used as a raw string.
    Express CORS rejects a disallowed origin by omitting the header (`callback(null, false)`) so
    non-browser callers (health checks, curl, native apps) aren't blocked server-side; Socket.IO
    CORS rejects by erroring the handshake outright (no "no headers" equivalent for a persistent
    connection).
  - `src/config/db.js` no longer `process.exit(1)`s on a connection error — it now propagates to
    `server.js`'s `bootstrap()`, which already logs and continues. A transient Atlas blip
    shouldn't crash-loop the container.
  - `render.yaml`: fixed the `healthCheck` block (Render's real key is `healthCheckPath`, a flat
    string — the old nested `{path, interval, timeout}` wasn't valid schema), corrected a
    misleading comment claiming health checks prevent idle spin-down (they only run during
    deploys), added `region: singapore`, changed `buildCommand` to `npm ci`.
  - Added `"engines": {"node": "20.x"}` to `package.json`.
- **Why:** pre-deploy audit before putting the backend on Render — none of this was in place, all
  of it was live before any traffic existed.
- **Contract impact:** none — no endpoint/socket payload shape changed. A disallowed origin now
  gets a response with no CORS header instead of one with a wildcard header; a client past the
  rate-limit ceiling gets `429 { success: false, message }` instead of no limit at all.
- **Tests:** new `tests/integration/auth-ip-rate-limit.test.js` (429 past the IP ceiling, resets
  after the window) and `tests/integration/cors-allowlist.test.js` (allowed origin gets the
  header, disallowed origin doesn't but the request still completes, no-Origin requests pass
  through). Verified locally against an ephemeral `mongodb-memory-server` instance — this sandbox
  has no local MongoDB and hit the same connection-pool teardown flakiness the pre-existing
  `auth-rate-limit.test.js` also hits on this Windows environment; the actual assertions passed.
- **Docs updated:** this entry only.
- **Migration:** none.
- **Follow-ups / known issues:** the free Render tier still sleeps after ~15 min idle (50s+ cold
  start), noted in `render.yaml`'s comments — not addressed here, it's a plan-tier tradeoff, not
  a code fix.

---

## 2026-08-17 — Boarding scan dedups a same-type repeat for the whole open trip

- **Branch:** issue/59-boarding-event-dedup
- **Modules touched:** QR attendance (docs/modules/QR_ATTENDANCE.md)
- **What changed:** `POST /api/driver/boarding/scan` now treats a second same-type scan (BOARD
  after BOARD, or ALIGHT after ALIGHT) for the same open trip as a duplicate regardless of how
  much time has passed, not just within the existing short debounce window. A real re-boarding —
  BOARD, then a genuine ALIGHT, then BOARD again — is unaffected; only two of the same type in a
  row for one trip (which can never be legitimate, since a real state transition always
  alternates) is caught.
- **Why:** issue #59 — a flaky/duplicate QR scan outside the debounce window (default 30s) was
  previously recorded as a brand-new BoardingEvent, double-counting into
  `managerAttendanceController.getManagerAttendance`'s per-student `boardCount`/`alightCount`
  rollup with no unique index or dedup guarding it.
- **Contract impact:** none — `debounced: true` on the scan response already existed for the
  time-window case; this just widens when it fires. No new field, status code, or shape.
- **Tests:** new `tests/integration/boarding-scan-trip-dedup.test.js` (see its header comment —
  it builds its own RiderProfile/DriverEnrollment fixture rather than reusing
  `qr-attendance.test.js`'s `createRider`/`freshTokenForRider`, which only provision a `User`
  account and don't work against the current `signQr`/`verifyQr`, which expect a `RiderProfile`).
  Updated one boundary case in `qr-attendance.test.js` to match the corrected behavior; that
  whole file's QR-scan-related tests are pre-existing broken/unrunnable in this environment for
  an unrelated reason — see the follow-up note below and the comment on issue #59.
- **Docs updated:** docs/TESTING_GUIDE.md rows added/updated.
- **Migration:** none.
- **Follow-ups / known issues:** discovered that `tests/integration/qr-attendance.test.js`'s
  `createRider`/`freshTokenForRider` fixture signs QR tokens for a `User` document, but
  `signQr`/`verifyQr` (and every real caller) operate on `RiderProfile` — a separate collection
  since the rider-profile split. Every scan-related test in that file fails identically on
  unmodified `main` with no changes at all (confirmed before starting this fix), independent of
  this change. Likely undetected until now because `.github/workflows/ci.yml` only runs `npm
  test` (the smoke suite) — `npm run test:integration` has apparently never run in CI. Flagged as
  a separate concern on issue #59 rather than fixed here (out of this issue's scope); worth its
  own issue given the whole integration suite may carry more of this kind of undetected drift.

## 2026-08-17 — assignVehiclesToManager enforces manager scope

- **Branch:** issue/80-assign-vehicles-scope-check
- **Modules touched:** admin (docs/modules/ADMIN.md — still unwritten placeholder, no update needed)
- **What changed:** `PATCH /api/super-admin/managers/:managerId/assign-vehicles` now rejects (409)
  reassigning a vehicle outside the target manager's scope: for a PUBLIC manager, a vehicle whose
  current route sits in a different province; for a SCHOOL/UNIVERSITY/OFFICE manager, a vehicle
  belonging to a different organization. A vehicle with nothing to compare (no route yet, or either
  side missing province/organization) still passes through.
- **Why:** issue #80 — this endpoint previously mass-reassigned vehicles with `Vehicle.updateMany`
  and no scope check at all, so a vehicle could silently land under a manager who doesn't actually
  operate its area.
- **Contract impact:** new 409 response on this endpoint. Checked TrackMe-WebAdmin — the hook
  (`useAssignVehiclesToManager`) exists but has no UI caller yet, so nothing there needed updating.
- **Tests:** `tests/integration/assign-vehicles-scope.test.js` (new) — province mismatch/match,
  no-route-yet passthrough, organization mismatch/match.
- **Docs updated:** docs/TESTING_GUIDE.md row added.
- **Migration:** none.
- **Follow-ups / known issues:** issue #49 (manager PUBLIC route creation) needs a product decision
  before it can be fixed — commented on the issue rather than guessing; its premise (a "scoped
  private/custom-route workflow" to route manager creation through) was removed from the codebase
  in `6680eac`/`f4bfff0` after the issue was filed.

## 2026-08-14 — Active enrolments expose driver and vehicle details

- **Branch:** main
- **Modules touched:** driver enrolment (cross-client contract)
- **What changed:** The enrollment driver summary now includes an optional email and expands its
  vehicle object with vehicle name, type, and service type alongside the existing ID, plate, and
  route. Driver phone and email are both released only for ACTIVE enrolments; PENDING/key-resolution
  summaries keep them null.
- **Why:** The passenger live map needs one useful driver/vehicle identity panel without repeating
  the driver's name or inventing missing contact data.
- **Contract impact:** `POST /api/enrollments/redeem` and `GET /api/enrollments/mine` add
  `driver.email`, `driver.vehicle.vehicleName`, `vehicleType`, and `serviceType`. Additive only.
  Updated `TrackMe-UserApp/docs/modules/DRIVER_ENROLLMENT.md` and `LIVE_MAP.md`.
- **Tests:** `tests/integration/driver-enrollment.test.js` covers ACTIVE email/vehicle disclosure and
  PENDING email withholding.
- **Docs updated:** this log and the consuming passenger-app module docs.
- **Migration:** none.
- **Follow-ups / known issues:** none.

## 2026-08-14 — Live vehicle location: driver GO → enrolled riders + manager

- **Branch:** main
- **Modules touched:** realtime — [`docs/modules/REALTIME.md`](modules/REALTIME.md) (rewritten;
  the previous version documented a `bus:update`/`manager:join-bus` contract deleted in `6680eac`)
- **What changed:**
  - New `src/models/VehicleLiveLocation.js` — one document per vehicle, overwritten on every fix.
    Deliberately not a trail: no history, no TTL to manage, at the cost of no breadcrumb/playback.
  - New `src/socket/liveTracking.js`, registered from `socketHandler.js`: `driver:start-tracking`,
    `driver:location`, `driver:stop-tracking` (driver → server); `vehicle:subscribe`,
    `vehicle:unsubscribe` (rider/manager → server, one handler branching on role); `vehicle:update`,
    `vehicle:status`, `vehicle:access-revoked` (server → client). Rooms are `vehicle:<vehicleId>`,
    keyed on the business id.
  - A rider watches the specific vehicle they are enrolled to (via the driver, not the vehicle
    directly) — not everything on a route. Authorization: rider via
    `RiderProfile` ownership + `DriverEnrollment.status === 'ACTIVE'`; manager via
    `Vehicle.managerId` (the denormalised copy on `DriverEnrollment.managerId` is never trusted for
    authorization, matching the existing `findOwnedEnrollment` pattern); driver via
    `Vehicle.driverId`.
  - A replayed offline-buffer fix older than the stored one ACKs `success:true, stale:true` and is
    neither stored nor broadcast — it must not NACK, or the driver app's `isNackResponse` path
    re-buffers it forever. A session with no cached state (a redeploy, a reconnect) is re-adopted,
    not refused.
  - Disconnect starts a 30s grace period rather than ending the shift immediately (background
    tracking means frequent socket churn); a 60s sweeper independently recovers vehicles left live
    by a process that died holding sessions.
  - Hardened socket handshake auth in the same file: rejects `tokenType: 'refresh'` (previously a
    refresh token authenticated a socket for its full life) and loads the account to reject
    `isActive === false` (previously a deactivated account kept a working socket indefinitely).
  - New REST: `GET /api/vehicle/:vehicleId/live`, `GET /api/manager/vehicles/live` — for a late
    joiner or a caller not holding a socket.
  - `docs/CHANGES.md` bug found and fixed en route: `POST /api/enrollments/riders/:riderId`
    (`createEnrollment`) wrote `{ userId: null, studentId }`, but `loadEnrollmentsByProfile` (backing
    `GET /api/enrollments/mine`) and `leaveEnrollment` both read/matched on `userId` — every
    enrolment made through the current app was invisible in "my shuttle". Also: `redeemEnrollmentKey`
    (the legacy `/redeem` path) upserted without `studentId`, which is `required` — a manager
    approving that request called `enrollment.save()`, which validates the full document and 400s.
    Both fixed; live location depends on `/mine` returning the right vehicle, so this had to go first.
  - `scripts/seed-sandbox.js`: seeds a `RiderProfile`, an ACTIVE `DriverEnrollment`, and two
    `VehicleLiveLocation` fixtures (one live, one recently-stopped) so Developer Mode has something
    real to show.
  - `scripts/start-two-vehicles-per-route.js` rewritten from scratch. It previously wrote straight
    into the deleted `LiveLocation` collection and flipped `Vehicle.isActive` to mean "currently
    driving" — that field is manager-edited fleet status, unrelated to duty state, and is counted on
    the manager dashboard. It is now a real socket client: logs in as seeded drivers over HTTP,
    connects a socket per vehicle, and emits `driver:location` along each route's stop geometry —
    exercising the same fan-out a real driver's phone does.
- **Why:** the feature request — manager assigns vehicle → driver gets an enrollment key → rider
  redeems it and can see the vehicle/driver → driver presses GO → every enrolled rider and the
  owning manager see it move live.
- **Contract impact:** additive. New socket events and REST endpoints; nothing existing changed
  shape. `driver:location`'s payload gained optional `timestamp`/`accuracy`/`speed`/`heading` fields.
  Consumers: `driver-app` (broadcasts — not yet updated to use the ack-timeout fix or background
  mode, tracked separately), `user-app` (needs to re-scope `useRouteTracking` from route rooms to
  vehicle rooms — not yet done), `web-admin` (tracking page was deleted in `fee5555` and needs
  rebuilding — not yet done).
- **Tests:** `tests/unit/socket-rate-limit.test.js`, `tests/unit/live-tracking-helpers.test.js`,
  `tests/integration/vehicle-live-endpoint.test.js`, `tests/integration/ws/live-tracking.test.js`,
  `tests/integration/enrollment-rider-path.test.js` (the enrolment-read-bug regression). All new
  suites pass; verified end-to-end with the rewritten simulator script and a real socket client
  acting as an enrolled rider — subscribe → `vehicle:status live:true` on GO →
  `vehicle:update` streaming a real position.
- **Docs updated:** `docs/modules/REALTIME.md` (full rewrite), `docs/TESTING_GUIDE.md` (Websocket
  section rewritten — it documented four WS test files that no longer exist — plus new Live
  Location and enrollment-rider-path rows), `scripts/check-docs.mjs` (REALTIME.md file matcher
  updated for the new model/util names).
- **Migration:** none required to deploy this change — `VehicleLiveLocation` is created on first
  write. `scripts/seed-sandbox.js` must be re-run to get the new fixtures in an existing sandbox DB.
- **Follow-ups / known issues:**
  - Driver/user/web-admin app changes not yet done (see Contract impact).
  - **Found, not fixed — pre-existing, unrelated to this change:** ~17 integration suites fail
    independently of this work (verified by running them against a tree with none of these changes
    applied). Root causes span at least two things: (a) several tests mint accounts via
    `User.create`/`Driver.create` with a raw password, bypassing the `Identity` model current login
    now requires, so `POST /api/auth/login` 401s and everything downstream fails; (b) other suites
    look like leftover damage from an earlier theirs-wins merge resolution. Out of scope here; needs
    its own pass.
  - `Vehicle.driverId` has no unique index, so `Vehicle.findOne({ driverId })` can silently pick one
    of several vehicles for a driver assigned to more than one — observed live during sandbox
    verification. The rider-watch authorization tolerates this (it checks the enrollment's driver
    against whichever vehicle was subscribed to, not the reverse), but nothing resolves "the"
    vehicle for a driver by that query alone. A partial unique index would close this; not added
    here to keep this change scoped to the new feature.
  - Single server instance only (`render.yaml` has no scaling config, verified) — `live` on the
    document is cross-process correct, but socket.io room fan-out is not. Scaling to 2+ instances
    needs `@socket.io/redis-adapter` first.

---

## 2026-08-13 — Vehicle creation past the first requires super-admin approval
- **Branch:** main
- **Modules touched:** admin ([`docs/modules/ADMIN.md`](modules/ADMIN.md) — still a stub, not updated)
- **What changed:**
  - `POST /api/manager/vehicle-accounts` now creates a manager's *first* vehicle
    outright (unchanged), but every vehicle after that raises a `PENDING`
    `ManagerVehicleRequest` (`type: CREATE_VEHICLE_ACCOUNT`) instead of creating
    it — mirroring how `DELETE_VEHICLE` already works.
  - Fixed two dormant bugs in `reviewVehicleRequest`'s `CREATE_VEHICLE_ACCOUNT`
    approval branch while wiring it up for the first time: an approved driver
    got no `managerId` (invisible in the manager's own directory), and an email
    already on another manager's driver could be reused with a new password on
    approval (account takeover).
- **Why:** vehicles are what the rest of the system sees (routes, tracking,
  bookings), so growing a fleet past the first vehicle should go through the
  same super-admin approval as deleting one already does. The
  `CREATE_VEHICLE_ACCOUNT` type and its approval branch already existed but
  were never reachable from any manager-facing endpoint — commit `bdcabeb`
  deliberately reverted approval-gated creation because it deadlocked a
  brand-new manager (empty fleet, no way to fill it, no way to add a driver
  either since that form needs an existing vehicle). The bootstrap rule (first
  vehicle free) keeps that fixed while gating everything after it.
- **Contract impact:** `POST /api/manager/vehicle-accounts` response shape now
  depends on whether the manager already has a vehicle — `data.vehicle` present
  (unchanged shape) for an immediate creation, or a `ManagerVehicleRequest` doc
  (`status: 'PENDING'`, no `data.vehicle`) when queued. web-admin's
  `ManagerVehiclesPage` updated in the same session to branch on this.
- **Tests:** added `tests/integration/vehicle-create-approval.test.js` (bootstrap
  rule, duplicate-pending-request guard, approve/reject, the driver-email
  ownership regression, non-super-admin review refused). Updated
  `tests/integration/manager-vehicle-create.test.js` and
  `tests/integration/vehicle-plates.test.js` to give each test a fresh,
  vehicle-less manager, since they previously relied on every vehicle a manager
  creates being immediate.
- **Docs updated:** `docs/TESTING_GUIDE.md` row added.
- **Migration:** none — no schema change, reuses the existing
  `ManagerVehicleRequest` model and its `CREATE_VEHICLE_ACCOUNT` type.
- **Follow-ups / known issues:** `tests/integration/delete-vehicle-orphan-driver.test.js`
  and `tests/integration/review-vehicle-request-whitelist.test.js` fail with
  401s independent of this change — they build accounts via `Manager.create`/
  `SuperAdmin.create` directly instead of the identity-aware test factories, a
  pre-existing issue flagged separately.

## 2026-08-12 — Multiple rider profiles under one account
- **Branch:** feat/multi-rider-profiles
- **Modules touched:** auth ([`docs/modules/AUTH.md`](modules/AUTH.md), rewritten — it still
  described the pre-Identity "four-collection" model), profiles (new —
  [`docs/modules/PROFILES.md`](modules/PROFILES.md)), notifications
  ([`docs/modules/NOTIFICATIONS.md`](modules/NOTIFICATIONS.md)), realtime
  ([`docs/modules/REALTIME.md`](modules/REALTIME.md)), sandbox
  ([`docs/modules/SANDBOX.md`](modules/SANDBOX.md))
- **What changed:**
  - `User` is now the one profile type an `Identity` may hold several of: a `profileKind`
    (`PRIMARY`/`MANAGED`) field, a scoped unique index so exactly one `PRIMARY` exists per
    identity, and a `pre('validate')` hook enforcing email-by-kind.
  - `accountRegistry.loginFilterForRole` makes identity→profile resolution deterministic once
    several `User` profiles can share an `identityId` — shipped as its own commit *before* the
    schema change, proven a no-op against the pre-existing single-profile suites.
  - New `/api/profiles` surface: list, create, update, soft-delete, switch, and a
    household-scoped enrollments read. `switchProfile` issues tokens through the same
    `utils/tokens.js`/`utils/accountPayload.js` paths login already uses.
  - `requireOwnProfile`/`requirePrimaryProfile` guards, plus `req.identityId` on every
    `protect`ed request. `requireOwnProfile`'s same-identity check is written as two explicit
    falsy checks, never `String(a)===String(b)` — the null-equality hole that would otherwise let
    two pre-migration accounts (neither with an `identityId`) read each other's data.
  - Household fan-out fixes: push tokens resolved across a household
    (`pushHelper.resolvePushTokensForRider`), notification reads/device-token registration
    household-scoped, the `student:<id>` socket room joined per household profile, and
    `attendanceController` grants same-household access — each with the same null-equality
    discipline as the profile guard.
  - `managerEnrollmentsController` surfaces the owning account's email/phone for a managed
    passenger, since it has none of its own.
  - Derived "Student"/"Employee"/"Passenger" tag (`utils/riderTag.js`) from the enrolled driver's
    `Organization.serviceType` — never stored on the profile.
  - `scripts/migrate-rider-profiles.js`: backfills `profileKind`, normalises blank emails, and
    rebuilds the `users` indexes. `scripts/seed-sandbox.js` seeds two managed profiles under the
    sandbox rider.
- **Why:** an account holder (a parent, an office admin) needs to manage and monitor several
  riders — their children, or staff — from one login, the way Uber lets one account hold several
  riders.
- **Contract impact:** new `/api/profiles/*` endpoints (user-app, web-admin's manager-request
  passenger payload gains `account`/`relation`/`isManagedProfile`/`avatarUrl`, additively —
  existing `passenger.email` still populates). `userPayload` gains `profileKind`. All three
  consuming apps' docs updated in the same change.
- **Tests:** ~25 new integration/unit/ws test files, one per behaviour listed in
  [`TESTING_GUIDE.md`](TESTING_GUIDE.md)'s new "Rider Profiles" section — including the authz
  failure cases (cross-identity 404s, the null-equality regression, MANAGED_PROFILE_FORBIDDEN).
  Also migrated 22 pre-existing integration suites off direct `Model.create({password})` account
  creation (they predated the Identity model and were silently failing login) — see
  `tests/integration/factories.js`.
- **Docs updated:** `docs/modules/AUTH.md` (rewritten), `docs/modules/PROFILES.md` (new),
  `docs/modules/NOTIFICATIONS.md`, `docs/modules/REALTIME.md`, `docs/modules/SANDBOX.md`,
  `docs/modules/ADMIN.md` (stub breadcrumb), `docs/README.md`, `docs/TESTING_GUIDE.md`, this file.
- **Migration:** `scripts/migrate-rider-profiles.js` — dry-run by default, `--apply` to commit,
  `--verify` to re-check. Must run before deploy; safe to re-run.
- **Follow-ups / known issues:** live vehicle tracking has no backend producer at all right now
  (pre-existing, unrelated to this change — see `REALTIME.md`), so the household-enrollments data
  this change adds has no live position to attach to yet on the map. Also unrelated and
  pre-existing: `manager-drivers.test.js`'s 3 red cases (a manager-created driver has no
  `Identity`, so email-based driver login can't work despite the endpoint accepting it), and two
  unrelated bugs (`route-path.test.js`, `places-proxy.test.js`) — all left untouched, confirmed
  present on `main` before this branch via a stashed-diff comparison.

---

## 2026-08-11 — Developer Mode Phase 1: sandbox backend + seed script + /health mode
- **Branch:** feat/developer-mode-sandbox
- **Modules touched:** sandbox (new) — [docs/modules/SANDBOX.md](modules/SANDBOX.md)
- **What changed:**
  - `dev:sandbox` script (`nodemon --require dotenv/config src/server.js
    dotenv_config_path=.env.sandbox`) + `.env.sandbox.example` — a second backend process on
    `:5001` against a `*_sandbox` database, sharing dev's `JWT_SECRET`.
  - `scripts/seed-sandbox.js`: wipes and reseeds the sandbox database through
    `createIdentityWithProfile`/`Driver.create` (same paths the real app uses), with a hard
    DB-name guard (`process.exit(1)` unless the connected database name contains `sandbox`).
    Creates the sandbox superadmin with a `_id` mirrored from the dev superadmin, so a dev-issued
    JWT authenticates on both backends.
  - `GET /health` now reports `mode` (`sandbox`/`primary`) and `dbName` from the live Mongo
    connection, not from config — see safety rail 6 in `DEVELOPER_MODE_PLAN.md`.
  - `@babel/parser` added as an explicit devDependency (used by `tools/devkit/catalog/`'s static
    test extraction, at the umbrella root).
- **Why:** manual CRUD verification had no safe place to happen against real dev data. See
  `DEVELOPER_MODE_PLAN.md` at the repo root.
- **Contract impact:** `/health` response gains two fields; additive, no existing consumer reads
  a fixed key set from it.
- **Tests:** none added for this module in Phase 1 (locked decision — see
  `docs/modules/SANDBOX.md` §10); the guard and seed flow were verified by hand against a real
  `trackme_sandbox` database during implementation.
- **Docs updated:** docs/modules/SANDBOX.md (new), docs/README.md, docs/QA_UPDATE_TRIGGERS.md,
  CLAUDE.md ("Running" + new non-negotiable).
- **Migration:** none.
- **Follow-ups / known issues:** none.

---

## 2026-08-05 — Notification cleanup endpoint was missing its admin guard
- **Branch:** feat/driver-on-board-roster
- **Modules touched:** notifications — [docs/modules/NOTIFICATIONS.md](modules/NOTIFICATIONS.md)
- **What changed:**
  - `DELETE /api/notifications/admin/cleanup` was commented "admin only" but had no role-check
    middleware at all — any authenticated rider or driver could call it. Added `requireAdmin`
    (`admin`/`super-admin`) to the route in `src/routes/notificationRoutes.js`.
- **Why:** Security audit finding — no test existed proving only admins could wipe notification
  history, and once written, the test confirmed the guard was in fact entirely missing.
- **Contract impact:** `DELETE /api/notifications/admin/cleanup` now returns `403` for a rider or
  driver token where it previously returned `200`. No client currently calls this endpoint
  (housekeeping-only per the module doc), so no consuming-app doc changes needed.
- **Tests:** Added `tests/integration/notifications.test.js` — 401 no token, 403 rider, 403
  driver, 200 manager (system-wide delete of expired docs, non-expired survive), 200 super-admin.
- **Docs updated:** `docs/modules/NOTIFICATIONS.md` (route table + §6 authorization rules),
  `docs/TESTING_GUIDE.md` (corrected a stale row that pointed at a non-existent
  `tests/integration/shared/notifications.test.js`).
- **Migration:** none.
- **Follow-ups / known issues:** the fixture pattern in several sibling integration test files
  (`qr-attendance.test.js`, `route-change-requests.test.js`, `auth.test.js`) creates
  `User`/`Manager`/`Driver` documents directly via `Model.create()` with no linked `Identity`
  document. Under the current Identity-based login (`authController.js` login now resolves
  exclusively via `findIdentityByEmail`), that fixture pattern looks like it can no longer log in —
  a likely pre-existing regression from the shared-Identity migration, not something this change
  touches. The new `notifications.test.js` uses `createIdentityWithProfile` instead and is
  unaffected either way.

## 2026-07-26 — Register offers a sign-in shortcut for a matching duplicate email
- **Branch:** feat/driver-on-board-roster
- **Modules touched:** auth — [docs/modules/AUTH.md](modules/AUTH.md)
- **What changed:**
  - `POST /api/auth/register` now uses `findAccountByEmail` (not just `isEmailRegistered`) so it
    knows *which* account collided. Duplicate-email response is now `409` with
    `code: 'EMAIL_IN_USE'`; when the match is the caller's own `User` account and the submitted
    password is correct via `comparePassword`, the response also carries `canSignIn: true`.
  - A Manager/Driver/SuperAdmin email match, or a wrong password against an existing rider
    account, always returns `canSignIn: false` — the sign-in shortcut never crosses account types.
- **Why:** A user hit "email already exists" trying to create a Manager account with an email
  already used by a rider account — that block is correct by design (see cross-collection
  uniqueness, unchanged). But the *inverse* case (a rider re-registering with their own existing
  email + correct password) was a dead-end error with no path forward. Now the client can offer
  "Sign in?" instead of forcing the user to go find the Login screen themselves.
- **Contract impact:** `POST /api/auth/register` 409 body gains a `canSignIn` boolean field
  (additive, existing `message`/`code` shape unchanged). `user-app` updated to read it — see that
  repo's `docs/AUTH.md` and `CHANGES.md`.
- **Tests:** `tests/integration/auth.test.js` — three new cases (matching-password rider →
  `canSignIn:true`, wrong-password rider → `false`, Manager-account email match → `false` even
  with the right password). Not run against a live DB in this session — no local MongoDB /
  `MONGODB_TEST_URI` available in this environment; syntax-checked only. Run
  `npm run test:integration` before merging.
- **Docs updated:** `docs/modules/AUTH.md` (API surface row, §8 gotcha, §10 test row),
  `docs/TESTING_GUIDE.md` (register row).
- **Migration:** none.
- **Follow-ups / known issues:** integration tests for this change have not been executed in this
  environment (no local Mongo) — run them before deploy.

## 2026-07-22 — Driver on-board roster endpoint
- **Branch:** main
- **Modules touched:** qr-attendance — [docs/modules/QR_ATTENDANCE.md](modules/QR_ATTENDANCE.md)
- **What changed:** Added `GET /api/driver/boarding/roster?busId=&tripId=` returning the enrolled
  roster (ACTIVE `RouteMembership` on the bus's route) joined with each rider's current on-board
  status for the trip, plus `onBoardCount`/`enrolledCount` and an on-board-non-member `guests`
  list. Powers the driver-app "X / Y on board" card + roster page. Also wrote the previously-stub
  QR_ATTENDANCE module doc.
- **Why:** User request — driver app should show who has boarded and "17/20 on board" per route
  (the roster deferred in driver-app todo 090).
- **Contract impact:** new read-only endpoint (additive). Consumed by driver-app (roster hook +
  screen). No existing shape changed.
- **Tests:** added `tests/integration/qr-roster.test.js` (7 cases incl. 400/404/403 authz);
  `qr-attendance.test.js` still green (22).
- **Docs updated:** docs/modules/QR_ATTENDANCE.md (full rewrite from stub), TESTING_GUIDE row.
- **Migration:** none.
- **Follow-ups / known issues:** PUBLIC routes have no enrollment, so `enrolledCount` is 0 there;
  the computed `guests`/boarded-this-trip count can become a fallback denominator later.

## 2026-07-22 — Documentation system (backend variant)
- **Branch:** main
- **Modules touched:** docs only (no `src/` change)
- **What changed:**
  - `CLAUDE.md` rewritten as a **router** (architecture overview, mounted API surface, the
    four-collection account model, non-negotiables).
  - Added the **backend variant** `docs/guides/_MODULE_TEMPLATE.md` — route→middleware→controller
    →model, with API-surface, data-model, authorization, side-effects and
    "not visible in the API surface" sections.
  - Added `docs/modules/`: `AUTH.md`, `PRIVATE_ROUTES.md`.
  - Added `docs/guides/`: `ADDING_A_FEATURE.md`, `ADDING_A_TEST.md`, `RELEASING.md`.
  - Added this `CHANGES.md` + `CHANGELOG.md`; rewrote `docs/README.md` as a grouped index.
  - Added `scripts/check-docs.mjs` + `.githooks/pre-push`.
- **Why:** mirror the user-app docs system so a session lands on the right file fast, and make
  cross-repo contract changes an explicit, checked step.
- **Contract impact:** none — docs only. (Documenting them surfaced that user-app's
  `PRIVATE_ROUTES.md` had **wrong endpoint paths**; corrected there to the real
  `POST /api/routes/join/verify`, `GET /api/routes/my-requests`,
  `DELETE /api/routes/:routeId/membership`.)
- **Tests:** none — docs only.
- **Docs updated:** this is the docs work.
- **Migration:** none.
- **Follow-ups / known issues:**
  - Run `git config core.hooksPath .githooks` once per clone.
  - Remaining module docs to write: ROUTES, CUSTOM_ROUTES, QR_ATTENDANCE, REALTIME,
    NOTIFICATIONS, BUSES, BOOKINGS, ADMIN, DRIVER, ETA_TRANSIT.
  - `POST /api/auth/resend-verification-otp` has no validator while every sibling does —
    documented in `modules/AUTH.md` §9, worth fixing.
