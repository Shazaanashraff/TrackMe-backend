# AUTH — TrackMe Backend

Registration, email verification, login (password + Google), JWT access/refresh, password reset,
profile/avatar, and the **Identity + role-profile model** with role-based guards.

**Status:** `SHIPPED`

**Consumed by:** all three clients — `user-app` ([`docs/AUTH.md`](../../../user-app/docs/AUTH.md)),
`driver-app`, `web-admin`.

---

## 1. Purpose

Own identity for every actor in the system. **One person's login is an `Identity`** — email,
password, verification/reset state — separate from the **role profile(s)** that person holds.
`User`, `Driver`, `Manager`, `SuperAdmin` are profile collections, each pointing at an `Identity`
via `identityId`; a rider who also drives holds two profiles under one `Identity` and signs into
both apps with the same password. The one exception: **`Driver` may have no `Identity` at all** —
a driver's permanent `driverCode` + password can be its sole, live credential. See
[`PROFILES.md`](PROFILES.md) for the further exception this made room for: **`User` is the one
profile type a single `Identity` may hold *several* of** — an account holder plus the riders
they manage.

## 2. API surface

All under `/api/auth` (`src/routes/authRoutes.js`). Every public endpoint runs a validator from
`middleware/validators.js` followed by `handleValidationErrors`.

| Method | Path | Auth | Controller fn | Notes |
|---|---|---|---|---|
| `POST` | `/register` | public | `register` | `validateRegister`. Creates an `Identity` + unverified `User` profile + the account holder's own `RiderProfile` + OTP. Optionally takes `category` (`SCHOOL`/`UNIVERSITY`/`OFFICE`) and `details` (what that category asks for, e.g. `{ grade }`), validated by `validateSignupDetails` and seeded onto that rider — see [`PROFILES.md`](PROFILES.md) §8. Both optional, so a client released before they existed still registers; Google sign-in never carries them and the app collects them on first launch. Duplicate email ⇒ 409 `code: 'EMAIL_IN_USE'`; if the match is the caller's own `User` profile and the submitted password is correct, adds `canSignIn: true`. |
| `POST` | `/verify-email` | public | `verifyEmail` | 6-digit OTP. |
| `POST` | `/resend-verification-otp` | public | `resendVerificationOtp` | **No validator** — see §9. |
| `POST` | `/login` | public | `login` | Accepts `identifier`/`email` + `password` (+ optional `audience`). Unverified ⇒ 403 `requiresVerification`, not a generic failure. A driver code as `identifier` bypasses `Identity` entirely — see §4. |
| `POST` | `/google` | public | `googleSignIn` | `validateGoogleSignIn`. |
| `POST` | `/refresh-token` | public | `refreshAccessToken` | Rotates the pair. |
| `POST` | `/forgot-password/request-otp` | public | `requestPasswordResetOtp` | |
| `POST` | `/forgot-password/verify-otp` | public | `verifyPasswordResetOtp` | Returns a short-lived reset token. |
| `POST` | `/forgot-password/reset` | public | `resetPasswordWithToken` | |
| `POST` | `/logout` | `protect` | `logout` | |
| `GET` | `/me` | `protect` | `getMe` | Re-reads the caller's own profile — see `user-app`'s `AUTH.md`. |
| `PUT` | `/profile` | `protect` | `updateProfile` | name, phoneNumber. `phoneNumber` is silently ignored for a `MANAGED` rider profile — see [`PROFILES.md`](PROFILES.md). |
| `PUT` | `/avatar` | `protect` | `updateAvatar` | base64 data URL; size re-checked in controller. |
| `POST` | `/account-code` | `protect` + `requireUser` | `accountController.requestAccountCode` | `{ purpose: 'CHANGE_PASSWORD' \| 'DELETE_ACCOUNT' }`. Emails a 6-digit code to the login's address (same rules as the forgot-password code: 5 minutes, wiped on the 5th wrong try). 3 requests per 10 minutes per login. `CHANGE_PASSWORD` on a Google-only login ⇒ 409 `NO_PASSWORD`. Dev echo `developmentOtp`, 502 when mail fails in production. |
| `POST` | `/change-password` | `protect` + `requireUser` | `accountController.changePassword` | `{ code, password }`, password policy as register. Revokes **every** session of every role on the login, then returns a fresh token pair (+ `user`) for the caller only. Emails "Password changed". |
| `POST` | `/delete-account` | `protect` + `requireUser` | `accountController.deleteAccount` | `{ code }`. Schedules deletion after a grace period (§8 "Account deletion"); returns `purgeAt`. Already scheduled ⇒ 409 `ACCOUNT_PENDING_DELETION`. |
| `POST` | `/delete-account/cancel` | `protect` + `requireUser` + `requirePrimaryProfile` | `accountController.cancelDeletion` | "Keep my account". Restores the ended enrollments, returns `user` and `restoredEnrollments`. Not scheduled ⇒ 409 `NOT_PENDING_DELETION`. |

## 3. Key files (one job each)

| File | Responsibility |
|---|---|
| `src/routes/authRoutes.js` | Route table + validator/guard wiring. |
| `src/controllers/authController.js` | All auth flows above. |
| `src/middleware/auth.js` | `protect`, `optionalAuth`, `requireRoles(...)`, the derived `requireDriver` / `requireUser` / `requireManagerOrAbove` / `requireManager` / `requireSuperAdmin`, and (for [`PROFILES.md`](PROFILES.md)) `requireOwnProfile` / `requirePrimaryProfile`. |
| `src/middleware/validators.js` | Per-endpoint request validation. |
| `src/middleware/errorHandler.js` | `handleValidationErrors` + central error → HTTP mapping. |
| `src/utils/accountRegistry.js` | `ACCOUNTS` (role → model), `modelForRole`, `loginFilterForRole`, `findAccountById`, `findAccountByDriverCode`, `isEmailRegistered` (a cross-collection email scan — used where a driver-code account, which has no `Identity`, must also be checked). |
| `src/utils/identityRegistry.js` | The `Identity`-centric operations: `findIdentityByEmail`, `findProfilesForIdentity`, `findHouseholdProfiles`, `resolveProfileForAudience`, `attachProfile`, `createIdentityWithProfile`, `isEmailRegistered` (single-`Identity` lookup — the one to reach for once you already know you're identity-linked). |
| `src/utils/tokens.js` | `issueTokensForUser`, `hashToken`, token-expiry config — shared by login, refresh, and `PROFILES.md`'s profile-switch endpoint. |
| `src/utils/accountPayload.js` | `userPayload` (the client-facing account shape) + `hydrateIdentity` — shared by every response that hands back an account. |
| `src/utils/ensureSuperAdminAccount.js` | Bootstraps the super-admin on startup. |
| `src/controllers/accountController.js` | Signed-in account actions: account code, change password, delete account, keep account. |
| `src/utils/sessions.js` | `revokeSessions(identityId, { roles, io, keepSocketsOf })`: bumps `sessionVersion`, clears refresh tokens, drops open sockets. |
| `src/utils/accountCode.js` | Issue/consume the emailed account-action code (`Identity.accountCode`). |
| `src/utils/accountEmails.js` | Code, password-changed, deletion scheduled/cancelled/done, and the manager rider-notice emails. |
| `src/services/accountDeletion.js` | Schedule, cancel and purge, the driver/manager notices, and the hourly purge sweep. |
| `src/models/Identity.js` | The login: email, password, verification/reset state. |
| `src/models/{User,Driver,Manager,SuperAdmin}.js` | The four profile collections. |
| `src/models/shared/accountFields.js` | The field set + indexes shared by all four profile collections, including the `multiplePerIdentity` option `User` alone uses — see [`PROFILES.md`](PROFILES.md). |

## 4. Data model

| Model | Key fields | Indexes / invariants |
|---|---|---|
| `Identity` | `email` (unique, global), `password` (bcrypt, `select:false`), `googleId`, `isEmailVerified`, `isProvisional`, `emailVerification.*`, `passwordReset.*`, `accountCode.{purpose,otpHash,expiresAt,attempts}` (all `select:false`) | `email` unique across the whole collection — this is where cross-role email uniqueness actually lives. |
| `User` (PRIMARY only) | `deletion.{requestedAt,purgeAt,enrollmentSnapshot}` (`enrollmentSnapshot` `select:false`) | Partial index `deletion_purgeAt_pending` on `deletion.purgeAt` for the purge sweep. |
| `User` / `Driver` / `Manager` / `SuperAdmin` | `identityId` (ref `Identity`), `name`, `email` (mirrored from `Identity.email`), `avatarUrl`, `isActive`, `sessionVersion` (stamped into access tokens as `sv`) | `email` unique **per collection**, so one `Identity` can hold a `User` and a `Driver` profile with the same mirrored email without colliding. `identityId` unique per collection too — **except `User`**, which allows several profiles per identity; see [`PROFILES.md`](PROFILES.md) for the exact index shape. |
| `Driver` | `driverCode` (permanent, sparse-unique) | May have **no** `identityId` — a driver-code driver's `password` field is its live credential, not a dormant mirror. |

`Identity.email` is the single source of email uniqueness; a profile's own `email` field is a
denormalised, never-user-editable mirror (`updateProfile` only ever touches `name`/`phoneNumber`).

Roles used by `requireRoles`: `'admin'` (manager), `'super-admin'`, `'driver'`, `'user'`.
Note `requireManager = requireRoles('admin')` — the manager role string is **`admin`**.

## 5. Request flow

```mermaid
flowchart TD
  A[Request] --> B[validator + handleValidationErrors]
  B --> C[controller]
  C --> D["identityRegistry: findIdentityByEmail / resolveProfileForAudience"]
  D --> E[(Identity)] --> F[(User | Driver | Manager | SuperAdmin)]
  G[Driver-code login] -.bypasses Identity.-> F
  H[Protected request] --> I["protect: verify JWT"]
  I --> J["accountRegistry.findAccountById(id, role)"] --> K[req.user hydrated]
  K --> L["requireRoles(...) guard"] --> M[controller]
  N[401 from client] --> O["POST /refresh-token"] --> P[new access+refresh pair]
```

## 6. Authorization & security rules

- `protect` verifies the JWT then **re-loads the profile document** via `accountRegistry` — a
  token alone is never trusted as the identity record.
- **Instant revocation.** Access tokens carry `sv`, the profile's `sessionVersion` at issue time.
  `protect` answers 401 `SESSION_REVOKED` and the socket handshake refuses (`Invalid token: session
  revoked`) when it no longer matches. A token with no `sv` (issued before this) counts as 0.
  `utils/sessions.js` bumps it, so a password change, a password reset or a deletion request ends
  other devices on their next request, not 15 minutes later.
- **Pending deletion.** While a rider's PRIMARY has `deletion.purgeAt`, `protect` answers 423
  `ACCOUNT_PENDING_DELETION` to every call except `GET /api/auth/me`, `POST /api/auth/logout`,
  `POST /api/auth/delete-account/cancel` and `/api/notifications/device-token`.
- `optionalAuth` hydrates `req.user` when a token is present but does not reject anonymous callers.
- `requireRoles(...roles)` is the single role gate; the named exports are thin wrappers. Manager
  endpoints must **additionally** scope to owned resources (see
  [`PRIVATE_ROUTES.md`](PRIVATE_ROUTES.md) §6) — a role check alone is not authorization.
- `protect` also sets `req.identityId` (the profile's own `identityId`, or `null`) — what
  [`PROFILES.md`](PROFILES.md)'s `requireOwnProfile` guards against a household-hijack with.
- Login on an unverified account returns **403 `requiresVerification`**, deliberately distinct from
  bad credentials, so clients can route to the OTP screen.
- The JSON body limit is **3 MB** app-wide (`server.js`), which is what makes base64 avatars viable.
- **HTTP rate limits** (`middleware/rateLimiters.js`, mounted in `server.js`). `apiLimiter` on
  `/api/*`: 600 per 15 minutes, counted per account for a request with a verified access token
  (`account:<role>:<id>`), otherwise per client address. `authLimiter` on `/api/auth/*`: 100 per 15
  minutes per client address only. The client address is `CF-Connecting-IP`, falling back to
  `req.ip` (local, tests). Since 2026-10-19: before that both keyed on `req.ip`, which on Render is
  a Cloudflare/Render proxy address even with `trust proxy` 1. One phone was counted in several
  rotating buckets, every rider on the same Cloudflare edge (Colombo) shared them, and two phones
  on one Wi-Fi shared one allowance. Cloudflare writes `CF-Connecting-IP` on every request to a
  Render web service and refuses a caller's own copy (403, error 1000), so it cannot be forged
  through the edge. A forged or refresh token never picks the account bucket: it is verified, and
  counts against the address. The per-identity limiters (`emailRateLimiter.js`) are unchanged.

## 7. Side effects

| Effect | Trigger | Detail |
|---|---|---|
| Email | register / resend / forgot-password / manager invite+reset | OTP or link delivery through `utils/mailer.js`: Resend first, then the SMTP (nodemailer) fallback when Resend is unset, errors, or throws (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`). Resend only delivers to its account owner until a sender domain is verified, so the fallback keeps verification codes reaching everyone meanwhile. |
| Account bootstrap | server start | `ensureSuperAdminAccount` creates the super-admin if absent. |
| Email | account code / change password / deletion scheduled, cancelled, purged | `utils/accountEmails.js`. A failed send never fails the action (except the code request itself, 502 in production). |
| Driver + manager notice | deletion scheduled / cancelled | Driver: a `driverOnly` system message in the rider's chat thread (ACTIVE enrollments only), pushed by the communications dispatcher. Manager: a `recipientRole: 'manager'` Notification (`RIDER_ACCOUNT_DELETED` / `RIDER_ACCOUNT_RESTORED`) announced on `account:<managerId>`, plus an email. |
| Purge sweep | server start, then hourly | `startDeletionSweeper` purges every PRIMARY whose `deletion.purgeAt` has passed. |

## 8. Not visible in the API surface

- **One `Identity`, several profiles.** A person may hold a `User` and a `Driver` profile under
  the same `Identity` and sign into both apps with one password — see
  `utils/identityRegistry.js`'s `attachProfile`/`createIdentityWithProfile`. A `super-admin`
  `Identity` may never hold any other role (`assertShareable`).
- **Driver-code sign-in bypasses `Identity` entirely.** A driver may have no email at all; the
  `driverCode` + password live directly on the `Driver` document. `accountRegistry.isEmailRegistered`
  (a cross-collection scan) exists specifically because a driver-code driver has no `Identity` for
  the identity-scoped `isEmailRegistered` to find.
- **A driver's password is stored twice, on purpose, and one copy is reversible.** Alongside the
  bcrypt hash, `Driver.passwordRecoverable` holds an AES-256-GCM ciphertext so the owning manager
  can read the password back (`GET /api/manager/drivers/:driverId/password`) and relay it to a
  driver who has no email. **This is the only recoverable credential in the system** and it is a
  deliberate exception, not a pattern to copy — it is the opposite of the 2026-07-08 decision that
  stopped super-admins seeing manager passwords. Limits that keep it contained:
  - **Authentication never reads it.** `comparePassword` still uses the bcrypt hash, so a corrupt,
    absent, or tampered ciphertext can never let anyone in.
  - **Off unless `DRIVER_PASSWORD_KEY` is set.** No key ⇒ nothing is written and the endpoint
    returns `503 PASSWORD_RECOVERY_DISABLED`. Leave it unset in production to disable entirely.
  - The key lives only in the environment, so a database leak alone does not decrypt it. A leak of
    **both** is a plaintext credential dump.
  - `select: false` on the field, so it cannot ride along on an ordinary driver query; the one
    endpoint allowed to read it opts in explicitly.
  - Every successful read writes a `DRIVER_PASSWORD_VIEWED` `ManagerAuditLog` entry (which never
    contains the password itself). See `utils/recoverablePassword.js`.
- **Avatars are base64 in Mongo, not object storage** — a deliberate, documented trade-off; the
  3 MB body limit is the practical ceiling. See the user-app `AUTH.md`.
- **Password policy** (8–64, upper/lower/digit/special) lives in `validators.js`, so a client can
  never relax it.
- OTPs carry expiry; the password-reset token is separate from and shorter-lived than an access
  token.
- **A password reset revokes every profile's session**, not just the one being reset from —
  `authController.revokeAllSessions(identityId)` (now `utils/sessions.js` `revokeSessions`) clears
  `refreshToken` and bumps `sessionVersion` on every profile sharing that `Identity`, `MANAGED`
  rider profiles included. In-app change password does the same, then re-issues the caller's pair.
- **`hasPassword` / `pendingDeletion` in `userPayload`.** `hasPassword` (present when the Identity
  is known) is exact when `+password` was loaded (`hydrateIdentity` and Google sign-in load it) and
  otherwise inferred from `googleId`. `pendingDeletion` is `{ purgeAt }` or `null` on every rider
  payload.
- **Account deletion** (`services/accountDeletion.js`). Grace period `ACCOUNT_DELETION_GRACE_DAYS`
  (default 3; `0` purges at the next sweep). On request: the household's PENDING and ACTIVE
  enrollments are snapshotted on the PRIMARY and deleted, push tokens cleared, rider sessions
  revoked (driver/manager sessions on the same login are untouched), driver and manager told.
  Signing in during the grace period works (payload carries `pendingDeletion`), register with the
  email is 409 `ACCOUNT_PENDING_DELETION`. Keeping the account re-inserts the snapshot rows (same
  `_id`s; a row is skipped if its driver or rider is gone). After `purgeAt`, the sweep, a sign-in
  (410 `ACCOUNT_DELETED`) or a register purges: household `User`s, `RiderProfile`s, places,
  enrollments, organization profiles, rider notifications, chats (conversations, messages,
  absences, announcement recipients, push deliveries), bookings and reviews. `BoardingEvent`s stay
  with `lat`/`lng` nulled and show as "Deleted rider"; the manager's notices stay without the
  name. The `Identity` is deleted only when no other profile still uses it.

## 9. Known gotchas / regressions

- **`/resend-verification-otp` has no validator** while every sibling endpoint does. It reads
  `email` straight from the body — validate defensively in the controller, and treat this as the
  known asymmetry when adding endpoints.
- `requireManager` maps to the role string **`'admin'`**, and `requireManagerOrAbove` accepts
  `'admin'` *or* `'super-admin'`. Easy to invert; the names do not read the way the strings do.
- New account types must be registered in `accountRegistry.js`'s `ACCOUNTS` list **and** given a
  role string that the guards expect.
- `protect` costs a DB read per request by design (fresh account state). Don't "optimise" it into
  trusting token claims.
- A `Driver` created by `managerDriversController` has **no `Identity`** — email-based driver
  login (as opposed to driver-code login) therefore cannot work for a manager-created driver
  despite the login endpoint accepting an email `identifier` for drivers. Tracked, not yet fixed
  (see `tests/integration/manager-drivers.test.js`'s three deliberately-red cases).

## 10. Tests covering this module

| Layer | File | What it locks |
|---|---|---|
| Unit | `tests/unit/rate-limiters.test.js` | `apiLimiter` per account (two accounts on one address apart, one account across addresses together), per `CF-Connecting-IP` without a token, forged/refresh tokens on the address, `req.ip` fallback; `authLimiter` per address only. |
| Integration | `tests/integration/auth-ip-rate-limit.test.js` | `authLimiter` throttles `/api/auth/*` after its max and resets after the window. |
| Unit | `tests/unit/account-login-filter.test.js` | `loginFilterForRole` — the account/profile precedence multiple rider profiles depend on. |
| Unit | `tests/unit/recoverable-password.test.js` | AES-GCM round trip, the feature gate, a fresh IV per record, and refusal (not garbage, not a throw) on a wrong key, a tampered tag, an unknown version, or malformed input. |
| Integration | `tests/integration/manager-driver-password.test.js` | Viewing a driver password: the cross-manager refusal, unauthenticated refusal, the audit entry (and that it never contains the password), 404 for a pre-feature driver, 503 with the feature off, ciphertext absent from ordinary reads, and that storage is encrypted while `password` stays bcrypt. |
| Integration | `tests/integration/account-actions.test.js` | Account code (401/403/400, Google-only 409, 3-per-10-minutes 429); change password (other sessions and roles 401 at once, caller's new pair works, wrong/expired/5-tries/wrong-purpose codes, policy); delete account (enrollments ended + snapshot, driver-only message, manager notices, 403 for drivers); grace period (423 gate, register 409, keep restores enrollments + notices); purge (household gone, boarding kept without GPS, manager notice anonymised, sign-in 410, driver login kept). |
| Unit | `tests/unit/account-deletion-grace.test.js` | `ACCOUNT_DELETION_GRACE_DAYS` parsing and `isDue`. |
| Integration | `tests/integration/auth.test.js`, `identity-registry.test.js`, `account-registry.test.js` | register→verify→login, unverified 403 `requiresVerification`, refresh rotation, forgot/reset chain, profile + avatar (incl. oversize rejection), role-guard 401/403 matrix, duplicate-email register (`canSignIn`). |

Canonical matrix: [`../TEST_PLAN_INTEGRATION.md`](../TEST_PLAN_INTEGRATION.md) and
[`../project/TEST_EDGE_CASES.md`](../project/TEST_EDGE_CASES.md).

## 11. Change protocol

See [`_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) §11. Auth touches **all three clients** —
a token/response-shape change must update every consuming app's auth doc in the same change.
