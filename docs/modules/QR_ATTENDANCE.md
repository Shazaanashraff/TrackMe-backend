# QR ATTENDANCE — TrackMe Backend

Account-scoped QR passes, driver scanning, BOARD/ALIGHT attendance events, and the driver-facing
on-board roster. The QR pass is **account-scoped** (one pass per rider, valid on every route);
the manager's per-route `qrEnabled` flag is the only gate on whether a driver's scan is accepted.

**Status:** shipped. This doc is the contract for `driver-app` (scanner + on-board roster) and
`user-app` (QR display) — a change to any response shape/status code here updates their module docs
too.

## Purpose

- Riders carry a reusable QR pass (a signed JWT) tied to their own account.
- A driver scans the pass in the vehicle to record a BOARD or ALIGHT event.
- The driver app shows a live "**X / Y on board**" count and a roster of who is aboard, where
  Y = riders enrolled on the bus's route.

## API surface

| Method | Path | Auth | Controller |
|---|---|---|---|
| POST | `/api/qr/issue` | `protect` (any account) | `qrController.issueQr` |
| POST | `/api/qr/rotate` | `protect` (self) | `qrController.rotateQr` |
| POST | `/api/driver/boarding/scan` | `protect, requireDriver` | `boardingController.scanBoarding` |
| GET | `/api/driver/boarding/roster` | `protect, requireDriver` | `boardingController.getBoardingRoster` |
| GET | `/api/attendance/student/:studentId` | `protect` (self or managing admin) | `attendanceController.getStudentAttendance` |
| GET | `/api/manager/attendance` | `protect, requireManager` | `managerAttendanceController.getManagerAttendance` |
| PATCH | `/api/manager/routes/:routeId/qr` | `protect, requireManager` (owner) | `managerPrivateRoutesController` (QR toggle) |

### GET /api/driver/boarding/roster

Query: `busId` (required), `tripId` (optional; defaults to `${busId}#YYYY-MM-DD`).

Returns the driver's currently-assigned bus's roster for the trip:

```json
{
  "success": true,
  "data": {
    "busId": "BUS-1",
    "routeId": "ROUTE-1",
    "tripId": "BUS-1#2026-07-22",
    "enrolledCount": 20,
    "onBoardCount": 17,
    "roster": [
      { "studentId": "...", "studentName": "Anna", "status": "ON",  "lastEventAt": "2026-07-22T08:01:00Z" },
      { "studentId": "...", "studentName": "Cara", "status": "NOT_BOARDED", "lastEventAt": null },
      { "studentId": "...", "studentName": "Ben",  "status": "OFF", "lastEventAt": "2026-07-22T08:10:00Z" }
    ],
    "guests": [
      { "studentId": "...", "studentName": "Zed", "lastEventAt": "2026-07-22T08:05:00Z" }
    ]
  }
}
```

- **Enrollment (the `/Y`)** = `RouteMembership` with `status:'ACTIVE'` on the bus's `routeId`. This
  only exists for PRIVATE / shuttle routes; a PUBLIC route with no memberships returns
  `enrolledCount: 0` and an empty `roster`.
- **status** is derived from each rider's *latest* `BoardingEvent` in the trip: latest `BOARD` ⇒
  `ON`, latest `ALIGHT` ⇒ `OFF`, no event ⇒ `NOT_BOARDED`.
- **onBoardCount** counts only enrolled members currently `ON`.
- **guests** = riders currently on board (latest event `BOARD`) who are *not* enrolled members;
  surfaced separately so the `onBoardCount / enrolledCount` headline stays clean.
- Roster is sorted `ON → NOT_BOARDED → OFF`, then by name.
- Errors: 400 missing `busId`; 404 bus not assigned to the caller; 403 route `qrEnabled:false`.

## Key files

- `src/controllers/boardingController.js` — `scanBoarding`, `getBoardingRoster`, `dayTripId`.
- `src/controllers/{qr,attendance,managerAttendance}Controller.js`.
- `src/routes/{qrRoutes,driverBoardingRoutes,attendanceRoutes}.js`.
- `src/models/BoardingEvent.js`, `src/models/RouteMembership.js` (enrollment source),
  `src/models/Route.js` (`qrEnabled`), `src/models/User.js` (`qrTokenVersion`).
- `src/utils/qrToken.js` (sign/verify), `src/utils/pushHelper.js` (boarding push).

## Data model (BoardingEvent)

One row per scan: `{ studentId(ref User), busId, routeId, driverId(ref Driver), type: BOARD|ALIGHT,
timestamp, lat?, lng?, tripId, source:'QR' }`. No formal "trip" entity yet — `tripId` defaults to
`${busId}#YYYY-MM-DD` so BOARD/ALIGHT toggling has a stable per-bus-per-day scope. Indexes support
latest-event-per-student lookups (`{studentId,tripId,timestamp}`) and the roster aggregation
(match `tripId`, sort `timestamp desc`, group by `studentId` → latest type).

## Authorization & security rules

- Every driver endpoint re-checks bus ownership server-side:
  `Bus.findOne({ busId, driverId: req.user._id, isDeleted:false })` → 404 otherwise.
- The roster exposes enrolled rider names to the driver of that route's bus only — scoped strictly
  to the caller's own assigned bus.
- `qrEnabled` gates both scan and roster (403 when false).

## Side effects

- On a successful scan the controller emits `attendance:event` to `route:<routeId>` and
  `student:<studentId>` rooms and fires a best-effort boarding push (never fails the response).
- The roster endpoint is read-only (no emits/writes).

## Tests

- `tests/integration/qr-attendance.test.js` — token utils, issue/rotate, scan (gate/toggle/
  debounce/push), manager QR toggle, attendance reads, device-token.
- `tests/integration/qr-roster.test.js` — roster status derivation, counts, guests, authz.
- `tests/integration/ws/qr-attendance-socket.test.js` — `student:<id>` auto-join.
- Traceability rows in [`../TESTING_GUIDE.md`](../TESTING_GUIDE.md) §QR Attendance.

## Change protocol

Changing any response shape/status here is a cross-repo change: update `driver-app`'s
`docs/modules` (scanner + roster) and `user-app`'s QR module doc in the same PR, add/adjust the
integration test, and append `docs/CHANGES.md`.
