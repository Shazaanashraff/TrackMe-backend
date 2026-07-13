# TODO 001 — QR Attendance foundation (token + events + push + aggregation)

**Priority:** P2 · **Depends on:** —
**Cite:** ../../docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md (READ FULLY FIRST),
`models/RouteMembership*`, `models/User.js`, `models/Bus.js`, `models/LiveLocation.js`,
the Socket.IO driver location pipeline, existing notification setup.

## Why
Backend foundation for QR boarding/attendance. Everything downstream (user-app 090, driver-app 090,
web-admin 025) depends on the contracts defined here, so keep the endpoint/payload shapes stable and
documented.

## Libraries
- **`jsonwebtoken`** (already present) — sign/verify the rotating QR token with a **dedicated secret**
  (`QR_JWT_SECRET` env; do NOT reuse `JWT_SECRET`).
- **`expo-server-sdk`** (add) — send Expo push to parents.

## Step-by-step
1. **Membership fields:** add `tokenVersion` (int, default 1) + `qrIssuedAt` to the route-membership
   model. Bumping `tokenVersion` revokes prior QRs.
2. **BoardingEvent model:** `{ studentId, membershipId, busId, routeId, driverId, type:'BOARD'|'ALIGHT',
   timestamp, lat?, lng?, tripId?, source:'QR' }` + indexes `{studentId,timestamp}`,`{routeId,timestamp}`.
3. **Token utils** (`utils/qrToken.js`): `signQr(membership)` → JWT `{sub,stu,rt,ver,jti}` with a
   moderate TTL (default 24h — finalize) signed by `QR_JWT_SECRET`; `verifyQr(token)` → checks
   signature, exp, and that `ver === membership.tokenVersion`.
4. **Endpoints:**
   - `POST /api/qr/issue` (user) → fresh token(s) for caller's membership(s).
   - `POST /api/qr/rotate` (user or manager) → bump `tokenVersion`.
   - `POST /api/driver/boarding/scan` (driver) → verify token, confirm the student's membership route
     matches the scanning bus's route, resolve `type` (explicit from body, else toggle from last event
     for that student+trip), **debounce** duplicate same-type scans within N seconds, persist
     `BoardingEvent`, emit push + socket. Idempotent.
   - `GET /api/attendance/student/:studentId?from&to` (parent-self or manager) → events + summary.
   - `GET /api/manager/attendance?from&to[&routeId]` (manager) → per-student rollup + ranking.
5. **Push:** on each BoardingEvent, send Expo push to the parent's device token(s) via
   `expo-server-sdk` ("‹Child› boarded/alighted ‹Bus› at HH:MM") + emit a Socket.IO event. Add a
   device-token registration endpoint if one doesn't exist.
6. **Tests:** integration for sign/verify (valid, expired, wrong-route, stale `tokenVersion`), scan
   idempotency/debounce + BOARD/ALIGHT toggle, push dispatch (mock Expo SDK), attendance aggregation.
   Add `docs/TESTING_GUIDE.md` rows for every new endpoint/contract. `.env.example` gets `QR_JWT_SECRET`.

## Out of scope
App UIs (their own todos). Student-report visualisation (web-admin 025). Offline replay lives in the
driver-app; the server just verifies authoritatively on receipt.

## Blocked — finalize during implementation
Confirm: token TTL + rotation cadence; whether ALIGHT is required to "close" a trip for attendance;
debounce window (seconds). Proceed with the documented defaults if the stakeholder doesn't object;
record the chosen values in the TESTING_GUIDE rows.

## Completion test
`todos/completion-tests/todo-001.sh` — `models/BoardingEvent*` + `utils/qrToken*` exist; the scan +
issue routes are registered; `QR_JWT_SECRET` in `.env.example`; `expo-server-sdk` in dependencies;
new attendance rows in `docs/TESTING_GUIDE.md`; `npm run test:integration` green.
