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
| `POST` | `/register` | public | `register` | `validateRegister`. Creates an `Identity` + unverified `User` profile + OTP. Duplicate email ⇒ 409 `code: 'EMAIL_IN_USE'`; if the match is the caller's own `User` profile and the submitted password is correct, adds `canSignIn: true`. |
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
| `src/models/Identity.js` | The login: email, password, verification/reset state. |
| `src/models/{User,Driver,Manager,SuperAdmin}.js` | The four profile collections. |
| `src/models/shared/accountFields.js` | The field set + indexes shared by all four profile collections, including the `multiplePerIdentity` option `User` alone uses — see [`PROFILES.md`](PROFILES.md). |

## 4. Data model

| Model | Key fields | Indexes / invariants |
|---|---|---|
| `Identity` | `email` (unique, global), `password` (bcrypt, `select:false`), `googleId`, `isEmailVerified`, `isProvisional`, `emailVerification.*`, `passwordReset.*` | `email` unique across the whole collection — this is where cross-role email uniqueness actually lives. |
| `User` / `Driver` / `Manager` / `SuperAdmin` | `identityId` (ref `Identity`), `name`, `email` (mirrored from `Identity.email`), `avatarUrl`, `isActive` | `email` unique **per collection**, so one `Identity` can hold a `User` and a `Driver` profile with the same mirrored email without colliding. `identityId` unique per collection too — **except `User`**, which allows several profiles per identity; see [`PROFILES.md`](PROFILES.md) for the exact index shape. |
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
- `optionalAuth` hydrates `req.user` when a token is present but does not reject anonymous callers.
- `requireRoles(...roles)` is the single role gate; the named exports are thin wrappers. Manager
  endpoints must **additionally** scope to owned resources (see
  [`PRIVATE_ROUTES.md`](PRIVATE_ROUTES.md) §6) — a role check alone is not authorization.
- `protect` also sets `req.identityId` (the profile's own `identityId`, or `null`) — what
  [`PROFILES.md`](PROFILES.md)'s `requireOwnProfile` guards against a household-hijack with.
- Login on an unverified account returns **403 `requiresVerification`**, deliberately distinct from
  bad credentials, so clients can route to the OTP screen.
- The JSON body limit is **3 MB** app-wide (`server.js`), which is what makes base64 avatars viable.

## 7. Side effects

| Effect | Trigger | Detail |
|---|---|---|
| Email | register / resend / forgot-password | OTP delivery. |
| Account bootstrap | server start | `ensureSuperAdminAccount` creates the super-admin if absent. |

## 8. Not visible in the API surface

- **One `Identity`, several profiles.** A person may hold a `User` and a `Driver` profile under
  the same `Identity` and sign into both apps with one password — see
  `utils/identityRegistry.js`'s `attachProfile`/`createIdentityWithProfile`. A `super-admin`
  `Identity` may never hold any other role (`assertShareable`).
- **Driver-code sign-in bypasses `Identity` entirely.** A driver may have no email at all; the
  `driverCode` + password live directly on the `Driver` document. `accountRegistry.isEmailRegistered`
  (a cross-collection scan) exists specifically because a driver-code driver has no `Identity` for
  the identity-scoped `isEmailRegistered` to find.
- **Avatars are base64 in Mongo, not object storage** — a deliberate, documented trade-off; the
  3 MB body limit is the practical ceiling. See the user-app `AUTH.md`.
- **Password policy** (8–64, upper/lower/digit/special) lives in `validators.js`, so a client can
  never relax it.
- OTPs carry expiry; the password-reset token is separate from and shorter-lived than an access
  token.
- **A password reset revokes every profile's session**, not just the one being reset from —
  `authController.revokeAllSessions(identityId)` clears `refreshToken` on every profile sharing
  that `Identity`, `MANAGED` rider profiles included.

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
| Unit | `tests/unit/account-login-filter.test.js` | `loginFilterForRole` — the account/profile precedence multiple rider profiles depend on. |
| Integration | `tests/integration/auth.test.js`, `identity-registry.test.js`, `account-registry.test.js` | register→verify→login, unverified 403 `requiresVerification`, refresh rotation, forgot/reset chain, profile + avatar (incl. oversize rejection), role-guard 401/403 matrix, duplicate-email register (`canSignIn`). |

Canonical matrix: [`../TEST_PLAN_INTEGRATION.md`](../TEST_PLAN_INTEGRATION.md) and
[`../project/TEST_EDGE_CASES.md`](../project/TEST_EDGE_CASES.md).

## 11. Change protocol

See [`_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) §11. Auth touches **all three clients** —
a token/response-shape change must update every consuming app's auth doc in the same change.
