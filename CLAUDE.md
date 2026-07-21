# backend — TrackMe Bus Tracking API

Express + Mongoose + Socket.IO service. Single API for **all three clients**: `user-app`
(passenger), `driver-app`, and `web-admin` (manager / super-admin).

**This file is a router, not a manual.** It gives you the shape of the service and points you at
the one doc you need. Deep detail lives in [`docs/`](docs/README.md) — do not duplicate it here.

---

## Session start

1. Check claude-mem for prior context (`/mem-search <topic>`) before re-reading files.
2. Open [`docs/README.md`](docs/README.md) — the documentation map.
3. Doing feature / test / release work? Go straight to the matching guide:
   - **Adding a feature** → [`docs/guides/ADDING_A_FEATURE.md`](docs/guides/ADDING_A_FEATURE.md)
   - **Adding a test** → [`docs/guides/ADDING_A_TEST.md`](docs/guides/ADDING_A_TEST.md)
   - **Cutting a release** → [`docs/guides/RELEASING.md`](docs/guides/RELEASING.md)
4. Before you push, append an entry to [`docs/CHANGES.md`](docs/CHANGES.md).

**One-time setup per clone** (enables the pre-push docs check):
```bash
git config core.hooksPath .githooks
```

> **This service is a contract for three apps.** Changing a response shape, status code, or socket
> payload is never backend-only — update the consuming app's module doc in the same change.

---

## Where to look (the map)

| I need to… | Read |
|---|---|
| Sign-up / login / JWT / refresh / roles | [`docs/modules/AUTH.md`](docs/modules/AUTH.md) |
| Routes CRUD, geometry, stops | [`docs/modules/ROUTES.md`](docs/modules/ROUTES.md) |
| Private routes: room key, join approval, membership | [`docs/modules/PRIVATE_ROUTES.md`](docs/modules/PRIVATE_ROUTES.md) |
| Driver-recorded custom routes + road snapping | [`docs/modules/CUSTOM_ROUTES.md`](docs/modules/CUSTOM_ROUTES.md) |
| QR passes + boarding/attendance events | [`docs/modules/QR_ATTENDANCE.md`](docs/modules/QR_ATTENDANCE.md) |
| Socket.IO: live locations, rooms, auth | [`docs/modules/REALTIME.md`](docs/modules/REALTIME.md) |
| Notifications + push delivery | [`docs/modules/NOTIFICATIONS.md`](docs/modules/NOTIFICATIONS.md) |
| Buses, reviews | [`docs/modules/BUSES.md`](docs/modules/BUSES.md) |
| Bookings | [`docs/modules/BOOKINGS.md`](docs/modules/BOOKINGS.md) |
| Manager / super-admin accounts, audit log | [`docs/modules/ADMIN.md`](docs/modules/ADMIN.md) |
| Driver accounts + earnings | [`docs/modules/DRIVER.md`](docs/modules/DRIVER.md) |
| ETA, transit planning, places, walking paths | [`docs/modules/ETA_TRANSIT.md`](docs/modules/ETA_TRANSIT.md) |
| Test coverage + traceability | [`docs/TESTING_GUIDE.md`](docs/TESTING_GUIDE.md) |
| What triggers a doc/test update | [`docs/QA_UPDATE_TRIGGERS.md`](docs/QA_UPDATE_TRIGGERS.md) |

---

## Architecture at a glance

```
src/
  server.js         Express app + HTTP server + Socket.IO. Mounts every /api/* router,
                    sets app.set('io', io) so controllers emit without importing io.
  config/db.js      Mongo connection (non-blocking startup).
  routes/*Routes.js Route tables only — path + middleware + controller fn.
  middleware/
    auth.js         protect, optionalAuth, requireRoles, requireDriver, requireUser,
                    requireAdmin, requireManager, requireSuperAdmin
    validators.js   Request validation
    errorHandler.js Central error → HTTP mapping
  controllers/      Request handling + orchestration (21 controllers, grouped by domain)
  models/           Mongoose schemas (18 models)
  socket/socketHandler.js   Rooms, auth, live-location fan-out, membership enforcement
  utils/            roomKey (AES-GCM+HMAC), qrToken, roadSnap, geo, pushHelper,
                    notificationHelper, accountRegistry, ensureSuperAdminAccount
```

### Mounted API surface (`server.js`)

`/api/auth` · `/api/bus` · `/api/routes` · `/api/notifications` · `/api/eta` · `/api/bookings`
· `/api/driver-earnings` · `/api/super-admin` · `/api/manager` · `/api/bus-reviews`
· `/api/places` · `/api/transit` · `/api/custom-routes` · `/api/qr` · `/api/attendance`
· driver boarding routes. Health: `GET /health`.

### Accounts are four collections, not one

`User`, `Driver`, `Manager`, `SuperAdmin` are separate models resolved through
`utils/accountRegistry.js` (`findAccountById`). `protect` uses it to hydrate `req.user`
regardless of account type — see [`docs/modules/AUTH.md`](docs/modules/AUTH.md).

---

## The non-negotiables

- **Routes contain no business logic.** route → middleware → controller → model.
- **Authorization is server-side, always.** A client hiding a control is UX, not security.
  Every manager endpoint must scope to the caller's own resources.
- **No untested code.** Behaviour changes ship with integration tests **including the authz
  failure cases**, plus a [`docs/TESTING_GUIDE.md`](docs/TESTING_GUIDE.md) row.
- **No undocumented module.** Update the [`docs/modules/`](docs/modules/) doc, starting from
  [`docs/guides/_MODULE_TEMPLATE.md`](docs/guides/_MODULE_TEMPLATE.md).
- **Contract changes are cross-repo.** Update the consuming app's module doc too.
- **Log the session.** Append to [`docs/CHANGES.md`](docs/CHANGES.md) before every push.

---

## Running

```bash
npm run dev              # nodemon
npm start                # node src/server.js
npm test                 # node --test smoke suite
npm run test:integration # jest integration suite
```

Seed/simulation helpers live in `scripts/` (`npm run seed`, `seed:routes`, `simulate`, …).
Environment + deploy config: [`SETUP.md`](SETUP.md), `render.yaml`, and
[`docs/guides/RELEASING.md`](docs/guides/RELEASING.md).
