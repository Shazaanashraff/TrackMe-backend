# TODO 001 — QR Attendance foundation (token + events + push + aggregation)

**Priority:** P2 · **Depends on:** —
**Cite:** ../../docs/features/qr-attendance/QR_SYSTEM.md (canonical — supersedes the original
QR_ATTENDANCE_PLAN.md), `models/User.js`, `models/Route.js`, `models/Bus.js`, the Socket.IO
connection handler, existing notification setup.

## Status: DONE (reworked 2026-07-18)

The first implementation of this todo (commit `19611a3`) built the QR token as
**RouteMembership-scoped** (one QR per route joined). A product-owner review found this
couldn't actually work: `RouteMembership` only exists for PRIVATE (PIN/approval) routes —
the public school/university/office routes riders actually use day-to-day have no
membership concept at all, so a rider on an ordinary shuttle route could never be issued a
QR in the first place.

**Reworked design (this version): the QR pass is account-scoped, not route-scoped.**
- One QR per user, valid on every route, with **no route gate at issuance** — any signed-in
  rider can generate/regenerate their pass anytime, confirmed with the product owner as the
  correct reading of "not route dependent."
- The manager's per-route `qrEnabled` toggle only gates whether a driver's scan on that
  route is *accepted* — not whether a rider can hold a pass.
- `RouteMembership` is untouched by this feature — it goes back to being purely the Private
  Routes access-grant model it was originally built for.

## What shipped

1. **`User.qrTokenVersion`/`qrIssuedAt`** (not on `RouteMembership`). Bumping `qrTokenVersion`
   instantly revokes every previously-issued pass.
2. **`Route.qrEnabled`** (boolean, default false) — the manager toggle from requirement #1.
3. **`BoardingEvent`** model: `{ studentId, busId, routeId, driverId, type:'BOARD'|'ALIGHT',
   timestamp, lat?, lng?, tripId?, source:'QR' }` — no `membershipId` (dropped; scanning
   never involves a membership lookup).
4. **Token utils** (`utils/qrToken.js`): `signQr(user)` → JWT `{ sub: userId, ver, jti }`
   (dropped `stu`/`rt` — meaningless for an account-scoped token) signed with the dedicated
   `QR_JWT_SECRET`; `verifyQr(token)` → checks signature, exp, active user, and
   `ver === user.qrTokenVersion`.
5. **Endpoints:**
   - `POST /api/qr/issue` → single account-scoped token, no body params.
   - `POST /api/qr/rotate` → self-only (the original manager-rotates-another-rider path was
     dropped — it depended on the membership/ownership chain that no longer applies here).
   - `POST /api/driver/boarding/scan` → verify token → resolve rider → look up the scanning
     bus's route → 403 if `!route.qrEnabled` → toggle BOARD/ALIGHT from the rider's last
     event → debounce duplicate same-type scans (30s default) → persist `BoardingEvent` →
     emit socket + push. Idempotent.
   - `PATCH /api/manager/routes/:routeId/qr` (new, not in the original spec) — the manager
     toggle, owner-scoped, mirrors `updateRoutePrivacy`.
   - `GET /api/attendance/student/:studentId?from&to`, `GET /api/manager/attendance` —
     unchanged from the original plan (already keyed off `studentId`/`routeId`, no rework
     needed).
6. **Push:** `sendBoardingPush` (unchanged, was already correctly user-scoped via
   `User.pushTokens`).
7. **Socket fix:** every authenticated connection now auto-joins `student:<userId>` on
   connect (`socket/socketHandler.js`) — previously the scan endpoint emitted to that room
   but no client ever joined it, so the live status-flip had nowhere to land.
8. **Tests:** `tests/integration/qr-attendance.test.js` rewritten for the new contract (22
   cases) + `tests/integration/ws/qr-attendance-socket.test.js` (new, covers the auto-join
   fix) + `PATCH .../qr` coverage. `docs/TESTING_GUIDE.md` has a QR Attendance section.

## Known gaps (see docs/features/qr-attendance/QR_SYSTEM.md "Known limitations")
- Scan response doesn't include the rider's name — driver-app's success feedback can't show
  who boarded, only the event type + time.
- Token is a static 24h JWT, not a rotating/time-boxed code — a screenshot of the QR is
  reusable by anyone for the full validity window.
- No geofencing — a scan is accepted regardless of the bus's actual GPS position.

## Completion test
`todos/completion-tests/todo-001.sh` — `models/BoardingEvent*` + `utils/qrToken*` exist; the
scan + issue routes are registered; `QR_JWT_SECRET` in `.env.example`; `expo-server-sdk` in
dependencies; attendance rows in `docs/TESTING_GUIDE.md`; `npm run test:integration` green.
