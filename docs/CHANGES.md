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

## 2026-08-14 — Super-admin dashboard KPIs stop full-scanning Booking/VehicleReview
- **Branch:** issue/83-lookup-to-indexed-match
- **Modules touched:** admin ([`docs/modules/ADMIN.md`](modules/ADMIN.md) — still a stub, note added)
- **What changed:**
  - `getManagerById` and `getOperationsOverview` in `superAdminController.js` no longer
    `$lookup` every `Booking`/`VehicleReview` document against `vehicles` and filter after
    the join. Both now fetch the relevant vehicle ids first (a fast, `managerId`-indexed
    `Vehicle` query) and `$match` the aggregation directly on `vehicleId` — an index seek on
    the existing `{ vehicleId, journeyDate, status }` / `{ vehicleId, createdAt }` compound
    indexes, instead of a full collection scan on every dashboard/operations load.
  - Added `src/utils/vehicleManagerRollup.js` — pure helpers that roll per-vehicle
    Booking/VehicleReview aggregation results up to per-manager totals (including a
    count-weighted average-rating rollup), since neither collection carries a `managerId`
    field of its own. `getManagerVehicleDetails` already used the equivalent
    pre-filtered-match pattern for its per-vehicle (not per-manager) view; this change
    brings the other two KPI endpoints in line with it.
  - Response shape is unchanged for both endpoints — this is an internal query-strategy fix.
- **Why:** issue #83 — these collections' compound indexes on `vehicleId` were going unused
  because the aggregation pipelines only matched on the joined `vehicleInfo.managerId` field,
  *after* `$lookup`/`$unwind`, which forces a full scan regardless of any index.
- **Contract impact:** none — response shape, status codes, and payload fields are identical.
- **Tests:** added `tests/unit/vehicle-manager-rollup.test.js` (14 cases, no DB needed) covering
  the new pure rollup helpers, incl. the weighted-average-rating math verified against a direct
  average of raw ratings, and orphaned-vehicle-id handling. `npm test` and `npx jest tests/unit`
  are green. The aggregation pipeline change itself (the Mongo query behavior) has **not** been
  verified end-to-end — `npm run test:integration` cannot run in this environment (no MongoDB /
  mongodb-memory-server available); see the PR for detail. Not merged for that reason.
- **Docs updated:** `docs/modules/ADMIN.md` (note), `docs/TESTING_GUIDE.md` (new row).
- **Migration:** none — no schema/index changes, only a query-strategy change.
- **Follow-ups / known issues:** `getOperationsOverview`'s KPI aggregations still run
  unconditionally on every page load with no caching (issue #62's broader concern) — out of
  scope here. Integration-test verification of the new pipelines is blocked on MongoDB
  availability in this environment; a future session with a working `mongodb-memory-server`
  should add an integration test asserting `getManagerById`/`getOperationsOverview` return
  identical KPI numbers before/after this change (e.g. via a seeded fixture with several
  managers, vehicles, bookings, and reviews) before merging.

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
