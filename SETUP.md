# TrackMe — Local Setup (for collaborators)

Get the whole platform running locally. Four repos are cloned **side by side**:

```
TrackMe/
  ├─ TrackMe-backend\     Node + Express + Mongoose + Socket.IO   → http://localhost:5000
  ├─ TrackMe-WebAdmin\    React 18 + Vite + MUI                   → http://localhost:5173
  ├─ TrackMe-UserApp\     Expo (React Native, web)                → http://localhost:8081
  └─ TrackMe-DriverApp\   Expo (React Native)                     → Expo Go / emulator
```

---

## 1. Prerequisites

- **Node.js** v18+ (tested on v24)
- **MongoDB** via Docker: `docker run -d --name trackme-mongo -p 27017:27017 mongo:7`
- For headless web testing of the UserApp: `npx playwright install chromium`

---

## 2. Environment files (your own keys)

Each `.env` is **gitignored** — create your own from the committed templates. **Use your own Google API keys** (don't commit or share keys in the repo).

```bash
# backend
cp TrackMe-backend/.env.example TrackMe-backend/.env
# userapp
cp TrackMe-UserApp/.env.example TrackMe-UserApp/.env
```

Then fill in the Google keys:

| File | Variable | Google API needed | Notes |
|------|----------|-------------------|-------|
| `TrackMe-backend/.env` | `GOOGLE_PLACES_KEY` | Places API (New) | **server-side only** — never expose to the client |
| `TrackMe-backend/.env` | `GOOGLE_GEOCODING_KEY` | Geocoding API (**billing enabled**) | reverse-geocode of dragged pins; falls back to `GOOGLE_PLACES_KEY` if unset |
| `TrackMe-backend/.env` | `GOOGLE_ROADS_KEY` | Roads API | snaps driver-recorded custom routes to roads; optional — falls back to `GOOGLE_ROUTES_KEY`, then `GOOGLE_PLACES_KEY`, then the raw unsnapped breadcrumb if none are set |
| `TrackMe-UserApp/.env` | `EXPO_PUBLIC_GOOGLE_MAPS_KEY` | Maps JavaScript API | **browser key** — ships in the client bundle; lock it down with an **HTTP-referrer restriction** (`http://localhost:8081/*`). Keep it separate from the server keys. |

> The Geocoding API requires an **active billing account** on its Google Cloud project (Places API New has a free tier; Geocoding does not). Restrict every key to just the API it needs and set a daily quota cap.

WebAdmin and DriverApp need no `.env` (WebAdmin defaults to `http://localhost:5000`).

---

## 3. Backend

```bash
cd TrackMe-backend
npm install
npm run dev          # nodemon, http://localhost:5000
```

Health check: http://localhost:5000/health → `{ "status": "ok", "isReady": true }`.
On first boot a super-admin is auto-created (see Test accounts below).

---

## 4. Seed the database (run once, backend connected to Mongo)

```bash
cd TrackMe-backend
npm run seed:wp               # 25 Western Province routes
npm run seed:manager-buses    # manager + 3 buses/route (75 buses)
npm run seed:start-journeys   # activates 2 buses/route with live positions
```

---

## 5. WebAdmin & UserApp

```bash
# WebAdmin (terminal)
cd TrackMe-WebAdmin && npm install && npm run dev          # http://localhost:5173

# UserApp web (terminal) — use --clear after changing .env so EXPO_PUBLIC_* re-inline
cd TrackMe-UserApp && npm install && npx expo start --web --port 8081
```

---

## 6. Live journey simulator (moving buses)

```bash
cd TrackMe-backend && npm run simulate     # Ctrl+C to stop
```

Tunables: `SIM_TICK_MS` (default 1500), `SIM_STEPS` (25), `SIM_SERVER_URL`, `SIM_FORCE_HOUR=8` to force a busy view.

---

## 7. Quick start (all together)

```bash
docker start trackme-mongo                                   # or the docker run above
cd TrackMe-backend && npm run dev                            # 1. backend
cd TrackMe-backend && npm run seed:wp && npm run seed:manager-buses && npm run seed:start-journeys   # 2. seed (once)
cd TrackMe-WebAdmin && npm run dev                           # 3. webadmin
cd TrackMe-UserApp && npx expo start --web --port 8081       # 4. userapp
cd TrackMe-backend && npm run simulate                       # 5. moving buses
```

---

## 8. Test accounts (created by the seed scripts)

| Role | Email | Password | Used in |
|------|-------|----------|---------|
| Super-admin | `ShazaanAshraff@SuperAdmin.com` | `SuperAdmin@123` | WebAdmin |
| Manager | `testadmin@mail.com` | `TestAdmin@123` | WebAdmin |
| Passenger | `passenger@trackme.com` | `Passenger@123` | UserApp |
| Drivers | `route.driver.001@bus.com` … | `Driver@123` | DriverApp |

> These are local dummy accounts that exist only in your own seeded database.

---

## 9. Tests

```bash
cd TrackMe-backend
npm test                 # smoke tests
npm run test:integration # jest + supertest (uses a separate trackme_test DB)
```
