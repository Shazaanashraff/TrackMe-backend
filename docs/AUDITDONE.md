# TrackMe Audit Remediation, Verified

Supersedes the tracker written by the antigravity CLI at
`~/.gemini/antigravity-cli/brain/5d9f0cb1-b979-48fa-81db-910fa61e755a/AUDITDONE.md`.
That file marked all 32 items complete. This one records what was actually found in the
code on 2026-08-23, item by item, and what had to be corrected.

This record spans all four TrackMe repos. It lives here because 20 of the 32 findings are
backend ones, and because a single owner beats four copies drifting apart. The UserApp,
WebAdmin and DriverApp changes it describes are committed in their own repos, on the
branches listed below.

Covers findings from:
1. Production Readiness Audit (2026-08-17)
2. Offline and Caching Audit (2026-08-17)
3. Security and Cryptographic Assessment (2026-08-22)

## Headline

The work was real and mostly good: 29 of 32 items were implemented correctly and confirmed
against the source. But **none of the backend or WebAdmin work had been committed**. It sat
in the working tree, one `git checkout` away from being lost. Three items were wrong or
incomplete, and one had been silently reverted.

| Repo | Branch | Commit |
|---|---|---|
| TrackMe-backend | `feature/audit-remediation` | `d44cea3` |
| TrackMe-WebAdmin | `feature/audit-remediation` | `7b99852` |
| TrackMe-UserApp | `feature/audit-remediation` | `34f62ca` |
| TrackMe-DriverApp | `feature/audit-remediation` | `e16bb93` |

Nothing has been pushed. Pushing is a per-push decision.

## Test baselines, recorded before and after

| Repo | Before | After |
|---|---|---|
| backend (`npm test`) | 3 pass, 0 fail | 3 pass, 0 fail |
| WebAdmin (`npm test`) | 59 files, 631 pass, 0 fail | unchanged |
| UserApp (`npm test`) | 872 pass, 2 fail | unchanged |
| DriverApp (`npm test`) | 426 pass, 37 fail | **429 pass, 34 fail** |

UserApp typecheck clean; lint 0 errors, warnings 408 to 407.
WebAdmin lint: no error or warning in any touched file.
DriverApp lint unchanged at 2 pre-existing errors, none in touched files.

## What was wrong

### 1. S2-1 broke rider phone numbers (critical, fixed)

The fix added an allow-list projection to `findAccountById` in `middleware/auth.js` to keep
2.7 MB of base64 avatar off every authenticated request. The goal was right; the mechanism
was not. An inclusion list decides what the whole app is allowed to read off `req.user`, and
it omitted `phoneNumber`, `qrTokenVersion` and `qrIssuedAt`.

Consequences traced in code:
- `utils/riders.js:56` `effectiveContactPhone` reads `account.phoneNumber`, so every rider
  returned by `publicRider` lost its contact phone unless it had an explicit override.
- `controllers/studentController.js:67` falls back to the account phone when the client sends
  none. Undefined there fails `validContactPhone` at `:71`, so `createRider` returned 400.
- `utils/riders.js:25` carried `qrTokenVersion` into a migrating legacy rider. Always reading
  1 could revive revoked QR passes.

Fixed by excluding only the heavy field (`select: '-avatarUrl'`). The models already carry
`avatarUrl: { select: false }` (`models/shared/accountFields.js:83`), so the payload win is
kept without the app-wide side effects.

### 2. SEC-2 left the payable amount client-controlled (high, fixed)

`createBooking` was changed to price from `Route.fare`, but:
- it fell back to the client's `pricePerSeat` when fare was missing or zero, and
- it still returned `amount: totalPrice`, the untrusted body value, as the payable amount,
  while storing the correct server figure on the booking.

`Route.fare` is `required: true` (`models/Route.js:48`), so the fallback was never needed.
Pricing now derives from `route.fare` alone, the body is no longer destructured for price,
and `bookingRoutes.js` no longer validates fields the controller ignores.

### 3. D-2 was reverted, and its tests were left behind (fixed)

The tracker claims the vehicle pill reads "Open enrolment"/"Approval required". It does not:
`VehicleCard.tsx:63` reads `Private`/`Public`, deliberately reverted in DriverApp commit
`c997741`. Two specs still asserted the audit wording and had been failing ever since. They
now assert what ships, keeping the behaviour they guard, notably that an unpopulated
`driverId` reads Public rather than being guessed as gated.

### 4. Smaller corrections

- **CORS**: wildcard origin was paired with `credentials: true`, which browsers reject on any
  credentialed request. Credentials are now sent only alongside an explicit origin list.
- **Graceful shutdown**: `server:shutdown` was emitted inside the `server.close()` callback,
  after the sockets carrying it were gone. It now goes out first.
- **P0-1 dead code**: the offline takeover was correctly removed but its wiring stayed in both
  apps (unused `OfflineScreen` import, a `backendOnline` prop nothing read, and the `App.js`
  state feeding it). Removed. DriverApp's `CLAUDE.md` still documented the takeover; corrected.

## Verified correct, no change needed

Each was checked against the source, including the schema facts the fix depends on.

| Item | Evidence |
|---|---|
| S1-1 EAS env URLs | `config.js:21-22` in both apps |
| S1-2 refresh tokens rejected | `middleware/auth.js:19,61` |
| S1-3 real PNGs | all 5 assets verified byte-level as `89 50 4E 47` |
| S1-4 RECORD_AUDIO removed | no match in `app.json` |
| S2-2 atomic location upsert | `liveTracking.js:307`. Safe because `VehicleLiveLocation.vehicleId` is `unique: true` (`:23`), so the 11000 catch cannot orphan a duplicate row |
| S2-3 page/limit clamps | `driverTripController.js:11-12` |
| S2-4 helmet + compression | `server.js:7,8,87,90` |
| S2-5 CORS whitelist | `server.js:44-46`, applied at `:51` and `:93` |
| S3-2 graceful shutdown | `server.js:240-241` |
| S3-3 constant-time compare | `utils/tokens.js:58,63`, `crypto` imported at `:5` |
| S3-4 dbName gated | `server.js:143` |
| P0-1 takeover removed | confirmed absent from both `AppNavigator.js` |
| P0-2 persist allow-lists | UserApp `queryClient.ts:6-20`, DriverApp `queryClient.ts:6` |
| P1-3 WebAdmin cache | `queryClient.js:15,17,22` |
| U-1 bell badge | `BellButton.js:8,12` |
| D-1 route fallback | `VehicleCard.tsx:40` |
| D-3/D-4 trip metrics | `TripHistoryScreen.js:36,40-44` |
| SEC-1 CSPRNG OTPs | `authController.js:237,745,1168`, zero `Math.random` remaining |
| SEC-3 manifest authz | `bookingController.js:396-402` |
| SEC-4 tenant scoping | `bookingController.js:458-462` |
| SEC-5 distinct vehicleId | `attendanceController.js:65`. Correct because `BoardingEvent.vehicleId` is a String (`:16`), not an ObjectId |
| SEC-6 verify-email lockout | `Identity.js:62,67`, `authRoutes.js`, and the null-deref after lockout is guarded at `authController.js:309` |
| SEC-7 review ownership | `vehicleReviewController.js:92-101,128-137` |
| SEC-8 cascade delete | `profileController.js:198`. Correct because `DriverEnrollment` carries both `studentId` and legacy `userId` (`:13,19`) |
| 6.3 responsive table | `data-table.jsx:135` |
| 6.4 tracking empty state | `ManagerTrackingPage.jsx:374` |
| 8.4 vendor chunks | `vite.config.js:20` |

## Open items, not addressed here

1. **No offline indicator outside Notifications (UserApp).** Removing the takeover was right,
   but `OfflineBanner` is only mounted in `NotificationsScreen`. Mounting it globally is a
   placement decision, since it currently renders below a screen header rather than above the
   navigator, so it was left for a decision rather than guessed at.
2. **`OfflineScreen.js` is an orphan** in both apps. Nothing renders it, but its tests and
   sandbox test-case entries still exist.
3. **DriverApp has 34 failing tests** across 5 suites (DutyHero, dutyHeroState,
   EnrollmentKeyCard, DriverDashboard, DriverProfileScreen). These are bento-redesign debt,
   the same class of stale assertion as the VehicleCard specs, and predate this work.
4. **WebAdmin's suite is timing-flaky** under CPU contention. Four consecutive runs of
   identical source gave 0, 9, 5 and 0 failures. Worth pinning down before trusting it in CI.
5. **`backend-run.log`** is untracked in the backend repo and deliberately not committed.
   It probably belongs in `.gitignore`.
6. **Test coverage for the corrected paths.** The audit shipped no tests. Still owed: the
   authz failure cases for SEC-3, SEC-4 and SEC-7 that `backend/CLAUDE.md` requires of any
   behaviour change, and a regression test pinning booking price to `Route.fare` so the
   client-controlled amount cannot come back.
