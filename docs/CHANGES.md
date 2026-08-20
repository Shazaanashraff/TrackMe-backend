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

## 2026-08-20 — The approval queue names the organization and labels its answers

- **Branch:** feature/rider-photos
- **Modules touched:** [`docs/modules/ADMIN.md`](modules/ADMIN.md) (managerEnrollmentsController)
- **What changed:**
  - `GET /api/manager/enrollment-requests` (and the approve/reject response) now carry
    `organization: {_id, name, serviceType}` per row, resolved from the rider's organization
    profile and falling back to the driver's own organization for a legacy row.
  - `passenger.organizationDetails` repeats the form answers as an ordered
    `{key, label, value}` list, labelled through `normalizedEnrollmentConfig()`.
    `passenger.organizationValues` is unchanged.
- **Why:** the web-admin queue could only render `grade: 4` with no sign of which organization
  asked, because the answers are stored keyed by field key and the payload named no organization.
- **Contract impact:** additive only. Consumer doc updated:
  `web-admin/docs/modules/ENROLLMENT_REQUESTS.md`.
- **Tests:** `tests/integration/manager-enrollments-managed-profile.test.js` (two new cases plus
  approve-response assertions), run against an isolated `trackme_test` database.
- **Docs updated:** [`docs/modules/ADMIN.md`](modules/ADMIN.md), TESTING_GUIDE row.
- **Migration:** none. Nothing is stored differently; the extra fields are derived per request.
- **Follow-ups / known issues:** sandbox seeds no PENDING enrollment, so this queue stays empty
  in Developer Mode.

## 2026-08-20 — Enrollments are read back per rider profile, not per account

- **Branch:** feature/rider-photos
- **Modules touched:** [profiles](modules/PROFILES.md) (enrollment read path)
- **What changed:**
  - `GET /api/enrollments/mine` now honours the `riderId` query parameter the passenger app
    has always sent, returning only that rider profile's enrollments.
  - Omitting `riderId` keeps the previous full-merge behaviour, so older clients are unaffected.
- **Why:** on an account with two rider profiles, `getMyEnrollments` merged every profile's
  enrollments into one list, so both riders showed the same cards. Enrolling one rider looked
  like it enrolled the other, and a Leave tap could delete the sibling rider's enrollment
  because the wrong record was on screen.
- **Contract impact:** `GET /api/enrollments/mine` gains an optional `riderId` filter; response
  shape unchanged. Documented on the client side in the user-app's
  `docs/modules/DRIVER_ENROLLMENT.md`. `getHouseholdEnrollments` and the shared
  `loadEnrollmentsByProfile` loader are untouched.
- **Tests:** `tests/integration/enrollment-rider-path.test.js` — new "multiple rider profiles on
  one account" case covering per-rider reads, the no-`riderId` back-compat path, and that leaving
  one rider's enrollment leaves the sibling's intact.
- **Docs updated:** user-app `docs/modules/DRIVER_ENROLLMENT.md`.
- **Migration:** none.
- **Follow-ups / known issues:** an enrollment already destroyed by this bug before the fix
  cannot be recovered in code — the affected rider has to redeem the enrollment key again.

---

## 2026-08-19 — A picture per rider, fetched on its own and versioned for caching

- **Branch:** feature/rider-photos
- **Modules touched:** [profiles](modules/PROFILES.md)
- **What changed:**
  - `RiderProfile` gains `avatarVersion`, bumped on every write to `avatarUrl`, including a clear.
  - `publicRider` no longer returns `avatarUrl`. It returns `hasAvatar` and `avatarVersion`, and
    the picture comes from the new `GET /api/riders/:riderId/avatar` (mirrored on the
    `/api/students` alias). Twenty riders at the 512 KB ceiling would otherwise have put ten
    megabytes into every list load, the same reason a MANAGED profile's avatar is off
    `/api/profiles`.
  - `createRider` / `updateRider` now validate `avatarUrl` through `utils/avatar.js`
    (`validateAvatarDataUrl`, 512 KB). The field was previously stored as
    `String(req.body.avatarUrl || '')` with no format or size check at all.
- **Why:** The passenger app is adding rider photos; the field existed but was unguarded, and
  inline delivery would have made every rider-list load carry every image.
- **Contract impact:** `GET /api/riders` **drops `avatarUrl`** and adds `hasAvatar` +
  `avatarVersion`; new `GET /api/riders/:riderId/avatar`. No client read the rider's `avatarUrl`
  (the only avatar in the UI is the account's), so nothing breaks today. `TrackMe-UserApp` picks
  this up in the same feature.
- **Tests:** `tests/integration/rider-avatar.test.js` (new).
- **Docs updated:** `docs/modules/PROFILES.md` (§2 rider table, §8), `docs/TESTING_GUIDE.md`.
- **Migration:** none. `avatarVersion` defaults to 0 and existing pictures keep working; their
  first edit moves the version to 1.
- **Follow-ups / known issues:** none.

## 2026-08-19 — The manager's approval queue knows who the request is for

- **Branch:** feature/signup-category
- **Modules touched:** [admin](modules/ADMIN.md), [profiles](modules/PROFILES.md), enrolment
- **What changed:** `managerEnrollmentsController` resolves the passenger from the enrolment's
  `studentId` (a `RiderProfile`) instead of the deprecated `userId`, which `createEnrollment`
  writes as null — so every request made through the rider path reached the manager as
  `passenger: null`. Rows from the legacy `/redeem` path still resolve by `userId` as a fallback.
  The payload now also carries `riderCode`, `contactPhone` and `organizationValues` (the answers
  that organization's enrolment form collected), and `isManagedProfile` means "not the account
  holder's own rider row".
- **Why:** The queue showed an unnamed request with no account and none of the details the rider
  had just entered, so a manager had nothing to decide on.
- **Contract impact:** Same response shape, correctly populated, plus three additive
  `passenger` fields. `passenger._id` is a rider profile id (it was an account id for legacy rows).
  `web-admin`'s page already read `riderCode` and `organizationValues`, so it needed no change;
  its `docs/modules/ENROLLMENT_REQUESTS.md` contract table is updated.
- **Tests:** `tests/integration/manager-enrollments-managed-profile.test.js` rewritten around the
  rider path (it previously built rows with a `userId` and no `studentId`, which the model has
  required for some time, so the suite could not run at all).
- **Docs updated:** `docs/modules/ADMIN.md`, `docs/modules/PROFILES.md`, `docs/TESTING_GUIDE.md`,
  and `TrackMe-WebAdmin/docs/modules/ENROLLMENT_REQUESTS.md`.
- **Migration:** none.
- **Follow-ups / known issues:** none for this queue.

## 2026-08-19 — A rider picks their category when the account is created

- **Branch:** feature/signup-category
- **Modules touched:** [auth](modules/AUTH.md), [profiles](modules/PROFILES.md), enrolment
- **What changed:**
  - `RiderProfile` gains `category` (`SCHOOL` / `UNIVERSITY` / `OFFICE`) and a `details` map, keyed
    by the enrolment field catalog so a school's `grade` given at signup is the same `grade` the
    school's enrolment form asks for.
  - `POST /api/auth/register` optionally takes `category` + `details` and seeds them onto the
    account holder's own rider row, which registration now creates rather than leaving to the
    first `GET /api/riders`.
  - `POST/PATCH /api/riders` accept the same pair, and every rider now returns `category`,
    `details` and `isSelf`.
  - Editing the `isSelf` rider mirrors `fullName` / contact phone onto the `User` account, so the
    passenger app's two competing profile editors can collapse into one without the two documents
    drifting apart.
  - `POST /api/enrollments/resolve-key` prefills `existingValues` from the rider's signup answers,
    overlaid by anything already saved for that organization. Every enabled field is still listed.
- **Why:** Signup asked nothing, so nothing was known about a rider until they redeemed a key, and
  the profile screen edited the same person through two unsynchronised documents.
- **Contract impact:** Additive on `/api/auth/register`, `/api/riders` (and the `/api/students`
  alias) and `resolve-key`. `PATCH /api/riders/:id` on the self record now also writes the account's
  name and phone. `TrackMe-UserApp` docs updated alongside its own change.
- **Tests:** `tests/integration/signup-category.test.js` (new), `tests/unit/enrollment-schema.test.js`
  (signup details cases).
- **Docs updated:** `docs/modules/AUTH.md`, `docs/modules/PROFILES.md` (§2 rider endpoints, §8),
  `docs/architecture/parent-student-profiles.md`, `docs/TESTING_GUIDE.md`.
- **Migration:** none. `category` is null on existing riders and the app collects it on first launch.
- **Follow-ups / known issues:** `createEnrollment` still writes `userId: null` while
  `managerEnrollmentsController` looks passengers up by `userId`, so the manager's approval queue
  shows `passenger: null` for enrolments made through the rider path, and never shows the values a
  rider entered. Untouched here.

---

## 2026-08-14 — Active enrolments expose driver and vehicle details

- **Branch:** feature/rider-photos
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

- **Branch:** feature/rider-photos
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
- **Branch:** feature/rider-photos
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
- **Branch:** feature/rider-photos
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
- **Branch:** feature/rider-photos
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
