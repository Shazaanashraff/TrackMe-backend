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
