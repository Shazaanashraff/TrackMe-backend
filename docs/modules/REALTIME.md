# REALTIME (Socket.IO) — TrackMe Backend

Live bus tracking transport: connection auth, room topology, driver location ingest, passenger
fan-out, and the membership gate that protects PRIVATE routes.

**Status:** `SHIPPED`

**Consumed by:** `driver-app` (location producer), `user-app`
([`LIVE_MAP.md`](../../../user-app/docs/modules/LIVE_MAP.md), `MY_SHUTTLE.md`), `web-admin`
(manager bus watch).

> Mined from the retired root-level `docs/modules/backend/SOCKET_IO_DOCUMENTATION.md` and
> **re-verified line-by-line against `src/socket/socketHandler.js`** — the old doc predated the
> private-route membership gate and the `student:` room.

---

## 1. Purpose

One Socket.IO server (created in `src/server.js`, exposed to controllers via `app.set('io', io)`)
carries every live signal in the system. Drivers push location; passengers and managers subscribe
to rooms and receive fan-out. The shaping constraint: **a socket connection is authenticated and
authorized independently of REST** — joining a PRIVATE route's room re-checks `RouteMembership`,
so a client cannot listen to a route it has no membership for.

## 2. Event surface

### Client → server (driver)
| Event | Payload | Notes |
|---|---|---|
| `driver:start-tracking` | `{ busId, … }` + ack | Joins `route:<routeId>`, `bus:<busId>`, `driver:<busId>`; broadcasts `bus:status-update`. |
| `driver:location` | location update + ack | The hot path — persists and fans out `bus:update`. |
| `driver:stop-tracking` | `{ busId }` + ack | Broadcasts `bus:status-update`. |

### Client → server (passenger)
| Event | Payload | Notes |
|---|---|---|
| `join-route` | `{ routeId }` + ack | **PRIVATE routes: checks `RouteMembership.exists(...)` first** and refuses non-members. |
| `leave-route` | `{ routeId }` + ack | |
| `route:get-recent-locations` | `{ routeId, limit }` + ack | Same membership check. Seeds a map before the first live tick. |

### Client → server (manager)
| Event | Payload | Notes |
|---|---|---|
| `manager:join-bus` / `manager:leave-bus` | `{ busId }` + ack | Joins `bus:<busId>` to watch one vehicle. |

### Server → client
| Event | Emitted to | Payload / trigger |
|---|---|---|
| `connection-success` | the socket | after successful auth |
| `route-joined` | the socket | ack of `join-route` |
| `bus:update` | `route:<routeId>` **and** `bus:<busId>` | every accepted `driver:location` |
| `bus:status-update` | `route:<routeId>` | driver start/stop tracking, **and on driver disconnect** |
| `attendance:event` | `route:<routeId>` **and** `student:<riderId>` | emitted by `boardingController.js` — see [`QR_ATTENDANCE.md`](QR_ATTENDANCE.md) |
| `route:access-revoked` | `route:<routeId>` | emitted by `managerPrivateRoutesController.js`; payload `{ routeId, userId }` |
| `error` | the socket | error channel |

## 3. Key files

| File | Responsibility |
|---|---|
| `src/socket/socketHandler.js` | Everything above: auth, rooms, handlers, fan-out. |
| `src/server.js` | Creates the `Server`, `app.set('io', io)` so controllers emit without importing `io`. |
| `src/models/LiveLocation.js` | Recent-location persistence backing `route:get-recent-locations`. |
| `src/models/RouteMembership.js` | The gate consulted on PRIVATE joins. |

## 4. Room topology

| Room | Who is in it | Purpose |
|---|---|---|
| `route:<routeId>` | passengers tracking a route, the driver | `bus:update`, `bus:status-update`, `attendance:event`, `route:access-revoked` |
| `bus:<busId>` | managers watching a bus, the driver | per-vehicle `bus:update` |
| `driver:<busId>` | the driver socket | driver-directed messages |
| `student:<userId>` | **auto-joined on connect** | per-rider `attendance:event` — no explicit join call from the client |

## 5. Authorization & security rules

- **Handshake auth:** `jwt.verify(token, process.env.JWT_SECRET)` sets `socket.userId`. An
  unauthenticated socket gets no `student:` room and fails every membership check.
- **PRIVATE route gate:** both `join-route` and `route:get-recent-locations` call
  `RouteMembership.exists({ userId, routeId, status: 'ACTIVE' })` before joining/serving. This is
  independent of the REST check — fixing a client bug never weakens it.
- **`route:access-revoked` fans out to the whole route room** carrying the revoked `userId`. Every
  rider on that route receives it; **the client is responsible for filtering**. Narrowing this to a
  per-user room would be a contract change affecting user-app.
- Drivers may only push location for a bus they are tracking (validated in `driver:location`).

## 6. Side effects

| Effect | Trigger | Detail |
|---|---|---|
| `LiveLocation` write | `driver:location` | backs recent-locations replay |
| `bus:status-update` | start / stop / **disconnect** | a driver dropping connection updates status, so the UI doesn't show a stale "tracking" bus |
| Session cleanup | `disconnect` | active-session tracking torn down |

## 7. Not visible in the API surface

- **Controllers emit without importing `io`** — always `req.app.get('io')`. Importing the instance
  creates a circular dependency and silently no-ops in tests.
- **`student:<userId>` is joined automatically on connect**, so per-rider pushes need no client
  join. Clients that "join their own room" are duplicating work.
- **Disconnect is a real event source**, not just cleanup: it emits `bus:status-update`.
- The socket layer shares the client's REST refresh path (`refreshAuthTokens`), so a token expiring
  mid-session doesn't race two refreshes — a *client* invariant, but it depends on this server
  accepting a refreshed token on reconnect.

## 8. Known gotchas / regressions

- **`bus:status-update` is emitted but ignored by user-app** — see
  [`LIVE_MAP.md`](../../../user-app/docs/modules/LIVE_MAP.md) §6. Not a backend bug; a client gap.
- Adding a broadcast to `route:<routeId>` reaches **every** subscriber, including riders who should
  not see user-specific data. Put per-user payloads in `student:<userId>`.
- The membership check is `async` inside the handler — joining the room before the `await`
  resolves would leak access. Keep `socket.join` after the check.

## 9. Tests covering this module

| Layer | File | What it locks |
|---|---|---|
| WS integration | `tests/integration/ws/` | handshake auth, `join-route` refused without ACTIVE membership, recent-locations refused likewise, `bus:update` fan-out to both rooms |

## 10. Change protocol

See [`_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) §11. Socket event names and payloads are
a **cross-repo contract** — a change here must update
[`user-app/docs/modules/LIVE_MAP.md`](../../../user-app/docs/modules/LIVE_MAP.md) and the driver-app
docs in the same change.
