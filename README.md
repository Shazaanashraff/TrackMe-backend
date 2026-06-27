# TrackMe — Backend & Full Local Setup

Express + Mongoose + Socket.IO service: REST API + real-time bus-location server
for the TrackMe bus-tracking platform (Western Province, Sri Lanka).

This README also documents how to bring up the **whole system** locally so a new
machine can run it the same way. The platform is split across four repos:

| Repo | Stack | Purpose | Default URL |
|------|-------|---------|-------------|
| **TrackMe-backend** | Node + Express + Mongoose + Socket.IO | REST API + realtime server | http://localhost:5000 |
| **TrackMe-WebAdmin** | React 18 + Vite + MUI | Manager / super-admin portal | http://localhost:5173 |
| **TrackMe-UserApp** | Expo (React Native, SDK 54) | Passenger app (track buses live) | http://localhost:8081 (web) |
| **TrackMe-DriverApp** | Expo (React Native) | Driver app (broadcast location) | Expo Go / emulator |

- https://github.com/Shazaanashraff/TrackMe-backend
- https://github.com/Shazaanashraff/TrackMe-WebAdmin
- https://github.com/Shazaanashraff/TrackMe-UserApp
- https://github.com/Shazaanashraff/TrackMe-DriverApp

Clone all four side by side:

```
TrackMe/
  ├─ TrackMe-backend/
  ├─ TrackMe-WebAdmin/
  ├─ TrackMe-UserApp/
  └─ TrackMe-DriverApp/
```

---

## 1. Prerequisites

- **Node.js** v18+ (tested on v24)
- **MongoDB** — Docker is easiest:
  `docker run -d --name trackme-mongo -p 27017:27017 mongo:7`
  (or a local `mongod`, or a MongoDB Atlas URI)
- **Google Cloud API keys** (see §3) — required for the journey planner & maps
- For headless web testing of the UserApp: `npx playwright install chromium`

---

## 2. Backend setup

```bash
cd TrackMe-backend
npm install
cp .env.example .env      # then fill in the values — see §3
npm run dev               # nodemon, auto-reload, http://localhost:5000
```

Health check: http://localhost:5000/health → `{ "status": "ok", "isReady": true }`.

On first boot a **super-admin** is auto-created:
`ShazaanAshraff@SuperAdmin.com` / `SuperAdmin@123`.

---

## 3. Environment & API keys

Copy `.env.example` → `.env` in **both** `TrackMe-backend` and `TrackMe-UserApp`
and fill in the values. `.env` files are gitignored and must **never** be committed.

API keys are **not** in the repo — get them one of two ways:
- **Use the team's keys** — ask the project owner to share them securely (password
  manager / Signal, not email or chat). For the browser key (UserApp) and OAuth
  client IDs, your `localhost` origin must be added to their HTTP-referrer /
  authorized-origins allow-list, or calls will be rejected.
- **Make your own** — create a Google Cloud project (with billing enabled) and
  generate the keys yourself.

Google Cloud APIs that must be enabled:
- **Backend** `GOOGLE_PLACES_KEY` (server-side, never shipped to client): Places API
  (New), Routes API, and Geocoding API (Geocoding is optional — the drag-pin reverse
  lookup falls back to free OpenStreetMap when it's absent/disabled).
- **UserApp** `EXPO_PUBLIC_GOOGLE_MAPS_KEY` (browser key, ships in the bundle — lock
  it down with HTTP-referrer restrictions): Maps JavaScript API.

Without a Maps key the UserApp map shows "Map unavailable"; email/password login
still works without the Google OAuth client IDs.

---

## 4. Seed dummy data (Western Province)

Run **once**, with the backend connected to MongoDB:

```bash
cd TrackMe-backend
npm run seed:wp               # 25 Western Province routes (2020 WP dataset)
npm run seed:manager-buses    # manager + 3 buses per route (75 buses)
npm run seed:start-journeys   # activates 2 buses/route + starting positions
```

The DB is not in git — re-run these after resetting the database. To snap stops
onto real bus stops (needs the Places key): `npm run snap:stops`, then restart
the backend so the road-path cache recomputes.

---

## 5. Test accounts

| Role | Email | Password | Used in |
|------|-------|----------|---------|
| Super-admin | `ShazaanAshraff@SuperAdmin.com` | `SuperAdmin@123` | WebAdmin |
| Manager (admin) | `testadmin@mail.com` | `TestAdmin@123` | WebAdmin |
| Passenger (verified) | `passenger@trackme.com` | `Passenger@123` | UserApp |
| Drivers | `route.driver.001@bus.com` … `075@bus.com` | `Driver@123` | DriverApp |

The passenger account is pre-marked email-verified so login works without an email
service (`RESEND_API_KEY` blank locally).

---

## 6. Live journey simulator (moving buses)

Drives the active buses along their routes in real time (connects as each bus's
driver, emits `driver:location`, which the server broadcasts to the UserApp):

```bash
cd TrackMe-backend
npm run simulate     # Ctrl+C to stop
```

Tunables: `SIM_TICK_MS` (default 1500), `SIM_STEPS` (25), `SIM_SERVER_URL`
(http://localhost:5000). Bus counts scale by time of day (peak 06–09 & 16–19, none
00–05) — force a busy view with `SIM_FORCE_HOUR=8 npm run simulate`.

---

## 7. Run the whole system (5 terminals)

```bash
# 0. MongoDB
docker run -d --name trackme-mongo -p 27017:27017 mongo:7   # or: docker start trackme-mongo

# 1. Backend                (http://localhost:5000)
cd TrackMe-backend && npm install && npm run dev

# 2. Seed data (once, after backend is up)
cd TrackMe-backend && npm run seed:wp && npm run seed:manager-buses && npm run seed:start-journeys

# 3. WebAdmin               (http://localhost:5173)
cd TrackMe-WebAdmin && npm install && npm run dev

# 4. UserApp (web)          (http://localhost:8081)
cd TrackMe-UserApp && npm install && npx expo start --web --port 8081

# 5. Moving buses
cd TrackMe-backend && npm run simulate
```

In the UserApp: hard-refresh (Ctrl+Shift+R), onboarding → Sign In → log in as the
passenger → pick a route → Track Live. WebAdmin needs no `.env` (defaults to
http://localhost:5000).

---

## 8. Tests

```bash
cd TrackMe-backend
npm test                   # node --test smoke tests
npm run test:integration   # jest + supertest against a dedicated trackme_test DB
```

Integration tests use a separate `trackme_test` database (override with
`MONGODB_TEST_URI`) and clean up after themselves, so dev data is untouched.

---

## 9. Notes

- After restarting, log in fresh in the browser (stale localStorage tokens).
  `ACCESS_TOKEN_EXPIRES_IN=7d` locally keeps the live socket from dropping.
- `SOCKET_DEBUG=1` on the backend enables verbose Socket.IO logs.
- Run `git pull` before starting work — multiple people push to these repos.
