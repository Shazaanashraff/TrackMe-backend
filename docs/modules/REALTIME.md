# REALTIME (Socket.IO) — TrackMe Backend

Everything the socket layer carries: connection auth, room topology, QR attendance transport, and
driver live-location broadcast + watch.

**Status:** `SHIPPED`

**Consumed by:** `driver-app` (location producer, `services/socket.ts`), `user-app` (location
watcher, `services/socket.js` → [`LIVE_MAP.md`](../../../user-app/docs/modules/LIVE_MAP.md),
`MY_SHUTTLE.md`), `web-admin` (manager fleet watch, `src/lib/tracking-socket.js`).

> Rewritten 2026-08-14 against the actual implementation. The previous version documented a
> `busId`-keyed contract (`bus:update`, `manager:join-bus`, `RouteMembership`) that was deleted in
> commit `6680eac` along with private routes — none of it existed by the time this doc claimed
> `Status: SHIPPED`. Live location has since been rebuilt vehicle-scoped, not route-scoped; see §9
> for what changed and why.

---

## 1. Purpose

One Socket.IO server (`src/server.js`, exposed to controllers via `app.set('io', io)`) carries two
independent features over one authenticated connection:

- **QR attendance** — a per-rider `student:<id>` room and `route:<routeId>` rooms that
  `boardingController.js` emits `attendance:event` into. See [`QR_ATTENDANCE.md`](QR_ATTENDANCE.md).
- **Live vehicle location** (`src/socket/liveTracking.js`) — a driver broadcasts position for their
  assigned vehicle; enrolled riders and the owning manager watch it. Rooms are keyed on the
  **business** `Vehicle.vehicleId`, never the ObjectId, so a driver and a rider that both mean the
  same vehicle always land in the same room regardless of which id form they sent.

The shaping constraint for location: **a rider watches the specific vehicle they are enrolled to**,
not everything on a route. Enrollment is to a driver (`DriverEnrollment.driverId`); the vehicle a
rider may watch is whichever one that driver currently has.

## 2. Event surface

### Client → server (driver)

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `driver:start-tracking` | `{ vehicleId }` | `{ success, data: { vehicleId, routeId, vehicleName, numberPlate, sessionId, startedAt } }` or `{ success:false, code, error }` | `vehicleId` must resolve to a vehicle assigned to the caller. Marks the vehicle `live: true` even before the first fix. |
| `driver:location` | `{ vehicleId, routeId?, lat, lng, timestamp?, accuracy?, speed?, heading? }` | `{ success, data: { acceptedAt, stale? } }` or `{ success:false, code, error }` | The hot path — upserts the vehicle's single `VehicleLiveLocation` doc and fans out `vehicle:update`. No prior `start-tracking` on this socket re-adopts the session rather than failing (see §6). |
| `driver:stop-tracking` | `{ vehicleId }` | `{ success:true }` or failure | Immediate offline — no grace period. |

`timestamp` is epoch ms from the device clock, **additive** (omitting it falls back to server
time). It exists so a replayed offline buffer can be told apart from a fresh fix — see §6.

### Client → server (rider / manager)

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `vehicle:subscribe` | `{ vehicleId, riderId? }` | `{ success, data: { vehicleId, live, location, vehicle, driver } }` or `{ success:false, code, error }` | `riderId` is **required** when `socket.userRole === 'user'`. Serves rider and manager through one handler, branching on role — see §5. Joins the room and seeds the current position in one round trip; there is no separate "get recent locations" call. |
| `vehicle:unsubscribe` | `{ vehicleId }` | `{ success:true }` | |

Unchanged from before: `join-route`, `leave-route` — QR attendance only, untouched by this work.

### Server → client

| Event | Emitted to | Payload / trigger |
|---|---|---|
| `connection-success` | the socket | after successful auth |
| `route-joined` | the socket | ack of `join-route` |
| `attendance:event` | `route:<routeId>` and `student:<id>` | see [`QR_ATTENDANCE.md`](QR_ATTENDANCE.md) |
| `vehicle:update` | `vehicle:<vehicleId>` | every **accepted** `driver:location` — see payload below |
| `vehicle:status` | `vehicle:<vehicleId>` | `{ vehicleId, live, reason, at }` — `reason` is one of `DRIVER_STARTED` \| `DRIVER_STOPPED` \| `DRIVER_DISCONNECTED` \| `STALE_TIMEOUT` |
| `vehicle:access-revoked` | `vehicle:<vehicleId>` | `{ vehicleId, riderId }` — emitted when a rider's ACTIVE enrolment is removed (`DELETE /api/enrollments/:id`); tells a watching socket to leave, since there is no other trigger that would make it stop |
| `error` | the socket | error channel |

`vehicle:update` payload:

```js
{
  vehicleId, routeId, vehicleName, numberPlate, serviceType,
  lat, lng, accuracy, speed, heading,
  recordedAt,   // ISO — device clock, clamped (see §6)
  receivedAt,   // ISO — server clock
  timestamp,    // ISO — alias of recordedAt
  driverId, sessionId, live: true
}
```

### Ack error codes

`RATE_LIMITED` · `INVALID_INPUT` · `INVALID_COORDS` · `FORBIDDEN_ROLE` · `VEHICLE_NOT_FOUND` ·
`RIDER_NOT_FOUND` · `NOT_ENROLLED` · `FORBIDDEN` · `TOO_MANY_SUBSCRIPTIONS` · `SERVER_ERROR`.

`VEHICLE_NOT_FOUND` is deliberately used for both "no such vehicle" and "not assigned to you" — a
driver probing ids should not be able to tell the difference.

## 3. Key files

| File | Responsibility |
|---|---|
| `src/socket/socketHandler.js` | Connection auth, QR attendance rooms/handlers, registers live tracking per connection, starts the staleness sweeper once per server. |
| `src/socket/liveTracking.js` | Everything location: the five events above, authorization, the upsert. |
| `src/models/VehicleLiveLocation.js` | One document per vehicle — current position, `live` flag, session bookkeeping. |
| `src/utils/liveVehicles.js` | In-memory session bookkeeping this **process** needs: which vehicles a socket owns, disconnect-grace timers, the staleness sweep. Never consulted to answer "is this vehicle live" — that is the `live` field on the document, readable by any process. |
| `src/utils/socketRateLimit.js` | Per-socket, per-event sliding-window limiter. |
| `src/utils/tripId.js` | `dayTripId(vehicleId)` — shared with `boardingController.js` so a location doc and a boarding scan agree on which trip they belong to. |
| `src/controllers/liveLocationController.js` | REST reads for a caller not holding a socket — see §8. |
| `src/server.js` | Creates the `Server`, `app.set('io', io)`. |

## 4. Room topology

| Room | Key | Who is in it | Purpose |
|---|---|---|---|
| `vehicle:<vehicleId>` | `Vehicle.vehicleId` (business id, e.g. `"VH-001"`) | the driver (from `start-tracking`), every subscribed rider/manager | `vehicle:update`, `vehicle:status`, `vehicle:access-revoked` |
| `route:<routeId>` | `Route.routeId` | passengers/driver tracking that route for attendance | `attendance:event` only — **no location traffic** |
| `student:<id>` | auto-joined per household profile on connect | the rider's own connections | `attendance:event` |

The vehicle room is always keyed on the **business** id. Both `driver:*` and `vehicle:subscribe`
resolve an ObjectId-shaped input to the vehicle's `vehicleId` before joining, but callers should
send `vehicleId` — resolving the ObjectId form exists for robustness, not as a supported input.

## 5. Authorization & security rules

| Caller | Check |
|---|---|
| driver (`driver:*`) | `socket.userRole === 'driver'`, then `Vehicle.findOne({ vehicleId, driverId: socket.userId, isDeleted: false })`. The result is cached on `socket.data.trackedVehicles` at start, so the hot `driver:location` path does no vehicle lookup at all once a session exists. |
| rider (`vehicle:subscribe`, role `user`) | `RiderProfile.exists({ _id: riderId, accountId: socket.userId, isActive: {$ne:false} })`, then `DriverEnrollment.exists({ studentId: riderId, driverId: vehicle.driverId, status: 'ACTIVE' })`. Checked against the vehicle's **driver**, not the vehicle itself — a manager reassigning a driver to a different vehicle mid-term does not need every enrolment rewritten. |
| manager (role `admin`) | `String(vehicle.managerId) === String(socket.userId)`. `Vehicle.managerId` is the authoritative assignment (unlike the denormalised copy on `DriverEnrollment.managerId`, which is not trusted for authorization anywhere in this codebase). |
| super-admin | unscoped. |

**Handshake auth is stricter than it used to be.** `io.use` verifies the JWT and additionally: (a)
rejects a token with `tokenType: 'refresh'` — previously a refresh token authenticated a socket for
its full life, same as an access token; (b) loads the account via `findAccountById` and rejects
`isActive === false` — previously a deactivated account kept a working socket until its token
expired on its own. Both are one query at connect time, not per message.

**Subscription cap:** a socket may hold at most `MAX_SUBSCRIPTIONS_PER_SOCKET` (25) `vehicle:`
rooms at once — enough for a manager watching a large fleet, not enough for enumeration.

## 6. The two behaviours that matter under a real mobile client

**A replayed offline buffer must not walk the marker backwards.** The driver app buffers up to 50
unsent fixes and replays them oldest-first on reconnect. If the server wrote every one, every
watcher's marker would jump backwards through the last several minutes before catching up. Instead,
`driver:location` compares the incoming `recordedAt` against the stored one and, if older, **stores
nothing and does not broadcast** — but still ACKs `{ success: true, data: { stale: true } }`. This
must be a success, not a NACK: `useLocationBroadcast`'s `isNackResponse` re-buffers anything it
reads as a failure, so a NACK here would replay the same stale batch forever.

**A session outliving its cached state must be re-adopted, not refused.** A backend redeploy drops
every socket; the driver's client reconnects and resumes emitting `driver:location` without calling
`start-tracking` again (or calls it against a vehicle whose `socket.data` cache is gone). Rather
than answering `VEHICLE_NOT_FOUND`, the handler re-resolves the vehicle, rebuilds the session, joins
the room, and emits `vehicle:status { live: true, reason: 'DRIVER_STARTED' }` as if this were a
fresh start. Refusing here would silently end a shift that is plainly still running.

**Rate limiting is sized to the client's known burst, not a round number.**
`driver:location` allows 60/s per socket. `useLocationBroadcast` throttles to roughly one fix every
2.5s in steady state, but the reconnect replay above sends its full 50-entry buffer with no spacing
between emits — a limit below the buffer size NACKs the tail, the client re-buffers what failed, and
the next reconnect replays it again. One dropped connection becomes a permanent livelock. See
`tests/unit/socket-rate-limit.test.js` and the WS suite's burst-replay case.

## 7. Disconnect, grace, and the staleness sweep

A driver's socket drops far more often once tracking runs in the background — doze, cell handover,
an OS process restart — so a disconnect does not end a shift immediately.

1. On `disconnect`, every vehicle this socket owned (`liveVehicles.ownedBy`) gets a
   `DISCONNECT_GRACE_MS` (default 30s, `LIVE_DISCONNECT_GRACE_MS`) timer.
2. Any `driver:start-tracking` or `driver:location` for that vehicle **from any socket** cancels the
   timer — the re-adoption path in §6 is what makes this work across a reconnect.
3. If the timer expires, the vehicle is marked `live: false, endedReason: 'DRIVER_DISCONNECTED'` and
   `vehicle:status` is emitted.
4. Independently, a sweeper (`liveVehicles.startSweeper`, one per server process, default interval
   `LIVE_SWEEP_INTERVAL_MS` = 60s) marks anything `live: true` with `receivedAt` older than
   `STALE_AFTER_MS` (default 90s) as `STALE_TIMEOUT`. This is the recovery path for a process that
   died holding sessions and never ran its disconnect handlers at all — grace timers alone cannot
   cover that case because they live in the memory of the process that crashed.

An explicit `driver:stop-tracking` skips grace entirely and ends the session immediately.

## 8. REST endpoints (no socket required)

For a late joiner, a list screen, or a manager map's polling fallback:

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/vehicle/:vehicleId/live?riderId=` | `protect` | Same authorization as `vehicle:subscribe`, role-branched in the controller. `riderId` required for role `user`. Mounted above the bare `/:vehicleId` route. |
| `GET` | `/api/manager/vehicles/live` | `protect`, `requireManager` | Every vehicle in the caller's fleet with its current position — the fleet itself is the authorization boundary. |

Both are pure reads; neither emits.

## 9. Not visible in the API surface

- **Controllers and the live-tracking module emit via `req.app.get('io')` / the closed-over `io`
  passed to `registerLiveTracking`, never by importing a module-level `io`.**
- **Liveness lives in two places on purpose.** `live` on `VehicleLiveLocation` is the
  cross-process-readable truth; `src/utils/liveVehicles.js`'s in-memory maps hold only what one
  process needs to clean up its own sockets. Answering "is this vehicle live" from the in-memory map
  alone would be wrong the moment there is more than one server instance.
- **One current-location document per vehicle, not a trail.** Every fix overwrites the same row.
  There is deliberately no history collection — the model this replaced (`LiveLocation`) had none
  either, but grew without a TTL; this design has no unbounded collection to begin with, at the cost
  of no breadcrumb/playback capability.
- **`lat`/`lng` are nullable.** A vehicle can be `live: true` with no position yet — the moment
  between a driver pressing GO and their first GPS fix arriving. A watcher joining in that window
  gets `location: null`, not an error.
- **`tripId` (`dayTripId(vehicleId)`) is shared with `boardingController.js`** so a location
  document and a QR boarding scan describe the same trip.
- **`Vehicle.managerId` and `Vehicle.driverId`, not `DriverEnrollment.managerId`, are the
  authorization sources.** The enrollment's copy is denormalised for listing only — see
  `managerEnrollmentsController.findOwnedEnrollment`'s comment on the same pattern.
- **`Vehicle.driverId` is not a unique index.** `Vehicle.findOne({ driverId })` can silently pick
  one of several vehicles if a driver is ever assigned to more than one. The rider-watch
  authorization above tolerates this (it checks the enrollment's driver against the *subscribed*
  vehicle's driver, not the reverse), but nothing in this module resolves "the" vehicle for a driver
  by that query — driver-initiated events always name the vehicle explicitly.

## 10. Known gotchas / regressions

- **`Vehicle.isActive` is not the live flag and must never be treated as one.** It is manager-edited
  fleet-status data — counted in the manager dashboard, filters route listings — unrelated to
  whether a driver has pressed GO. A previous implementation of this feature flipped it on start;
  do not repeat that.
- **`student:<id>` rooms are joined with `User._id`, but `boardingController.js` emits attendance to
  `student:<RiderProfile._id>`.** These only coincide for a legacy rider whose profile reused the
  account's `_id`. This is a pre-existing QR attendance issue, unrelated to and not fixed by this
  module — live location deliberately uses its own `vehicle:` rooms rather than routing through
  `student:` rooms, so it is not exposed to this mismatch.
- **Single server instance only.** `live` on the document is correct across processes; socket.io
  room fan-out is not. With two or more instances behind a load balancer, a rider connected to
  instance B will never receive an update produced by a driver on instance A. `render.yaml`
  currently runs one instance, so this is not live, but scaling out requires
  `@socket.io/redis-adapter` first.
- Adding a broadcast to `route:<routeId>` still reaches every subscriber on that route — unrelated
  to location, which never uses route rooms, but worth remembering if attendance work touches this
  file too.

## 11. Tests covering this module

| Layer | File | What it locks |
|---|---|---|
| Unit | `tests/unit/socket-rate-limit.test.js` | per-socket/per-event windows, the 50-entry buffer burst, disconnect cleanup |
| Unit | `tests/unit/live-tracking-helpers.test.js` | `validCoord`, `resolveRecordedAt` clock-skew clamping |
| Integration | `tests/integration/vehicle-live-endpoint.test.js` | REST authz for every caller type, every status code |
| WS | `tests/integration/ws/live-tracking.test.js` | start/location/stop, overwrite-not-append, replay staleness, authorization for rider/manager/driver, disconnect grace, reconnect re-adoption, buffer-burst rate limiting, hardened socket auth, revocation on leaving an enrolment |
| WS | `tests/integration/ws/household-socket.test.js` | unrelated to location — household `student:` auto-join, unchanged |

## 12. Change protocol

See [`_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) §11. Socket event names and payloads are
a **cross-repo contract** — a change here must update
[`user-app/docs/modules/LIVE_MAP.md`](../../../user-app/docs/modules/LIVE_MAP.md) and the
driver-app's tracking docs in the same change.
