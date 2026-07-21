# AUTH — TrackMe Backend

Registration, email verification, login (password + Google), JWT access/refresh, password reset,
profile/avatar, and the **four-collection account model** with role-based guards.

**Status:** `SHIPPED`

**Consumed by:** all three clients — `user-app` ([`docs/AUTH.md`](../../../user-app/docs/AUTH.md)),
`driver-app`, `web-admin`.

---

## 1. Purpose

Own identity for every actor in the system. The shaping constraint: **accounts live in four
separate collections** (`User`, `Driver`, `Manager`, `SuperAdmin`), not one table with a role
column — so every lookup goes through `utils/accountRegistry.js`, and `protect` must hydrate
`req.user` without knowing which collection the caller came from.

## 2. API surface

All under `/api/auth` (`src/routes/authRoutes.js`). Every public endpoint runs a validator from
`middleware/validators.js` followed by `handleValidationErrors`.

| Method | Path | Auth | Controller fn | Notes |
|---|---|---|---|---|
| `POST` | `/register` | public | `register` | `validateRegister`. Creates unverified account + OTP. |
| `POST` | `/verify-email` | public | `verifyEmail` | 6-digit OTP. |
| `POST` | `/resend-verification-otp` | public | `resendVerificationOtp` | **No validator** — see §9. |
| `POST` | `/login` | public | `login` | Unverified ⇒ 403 `requiresVerification`, not a generic failure. |
| `POST` | `/google` | public | `googleSignIn` | `validateGoogleSignIn`. |
| `POST` | `/refresh-token` | public | `refreshAccessToken` | Rotates the pair. |
| `POST` | `/forgot-password/request-otp` | public | `requestPasswordResetOtp` | |
| `POST` | `/forgot-password/verify-otp` | public | `verifyPasswordResetOtp` | Returns a short-lived reset token. |
| `POST` | `/forgot-password/reset` | public | `resetPasswordWithToken` | |
| `POST` | `/logout` | `protect` | `logout` | |
| `PUT` | `/profile` | `protect` | `updateProfile` | name, phone. |
| `PUT` | `/avatar` | `protect` | `updateAvatar` | base64 data URL; size re-checked in controller. |

## 3. Key files (one job each)

| File | Responsibility |
|---|---|
| `src/routes/authRoutes.js` | Route table + validator/guard wiring. |
| `src/controllers/authController.js` | All auth flows above. |
| `src/middleware/auth.js` | `protect`, `optionalAuth`, `requireRoles(...)`, and the derived `requireDriver` / `requireUser` / `requireAdmin` / `requireManager` / `requireSuperAdmin`. |
| `src/middleware/validators.js` | Per-endpoint request validation. |
| `src/middleware/errorHandler.js` | `handleValidationErrors` + central error → HTTP mapping. |
| `src/utils/accountRegistry.js` | `findAccountByEmail`, `findAccountById`, `isEmailRegistered`, `modelForRole` over the four account models. |
| `src/utils/ensureSuperAdminAccount.js` | Bootstraps the super-admin on startup. |
| `src/models/{User,Driver,Manager,SuperAdmin}.js` | The four account collections. |

## 4. Data model

| Model | Key fields | Indexes / invariants |
|---|---|---|
| `User` | email, password hash, `isVerified`, OTP + expiry, profile (name, phone, avatar) | Email unique **within** the collection. |
| `Driver` / `Manager` / `SuperAdmin` | same identity shape, role-specific fields | Each its own collection. |
| — | — | **Email uniqueness is cross-collection** and enforced by `isEmailRegistered` in application code, *not* by a database constraint — see §8. |

Roles used by `requireRoles`: `'admin'` (manager), `'super-admin'`, driver, user.
Note `requireManager = requireRoles('admin')` — the manager role string is **`admin`**.

## 5. Request flow

```mermaid
flowchart TD
  A[Request] --> B[validator + handleValidationErrors]
  B --> C[controller]
  C --> D["accountRegistry.findAccountByEmail / findAccountById"]
  D --> E[(User | Driver | Manager | SuperAdmin)]
  F[Protected request] --> G["protect: verify JWT"]
  G --> H["findAccountById(id, role)"] --> I[req.user hydrated]
  I --> J["requireRoles(...) guard"] --> K[controller]
  L[401 from client] --> M["POST /refresh-token"] --> N[new access+refresh pair]
```

## 6. Authorization & security rules

- `protect` verifies the JWT then **re-loads the account** via `accountRegistry` — a token alone is
  never trusted as the identity record.
- `optionalAuth` hydrates `req.user` when a token is present but does not reject anonymous callers.
- `requireRoles(...roles)` is the single role gate; the named exports are thin wrappers. Manager
  endpoints must **additionally** scope to owned resources (see
  [`PRIVATE_ROUTES.md`](PRIVATE_ROUTES.md) §6) — a role check alone is not authorization.
- Login on an unverified account returns **403 `requiresVerification`**, deliberately distinct from
  bad credentials, so clients can route to the OTP screen.
- The JSON body limit is **3 MB** app-wide (`server.js`), which is what makes base64 avatars viable.

## 7. Side effects

| Effect | Trigger | Detail |
|---|---|---|
| Email | register / resend / forgot-password | OTP delivery. |
| Account bootstrap | server start | `ensureSuperAdminAccount` creates the super-admin if absent. |

## 8. Not visible in the API surface

- **Four collections, one identity surface.** Adding an account type means updating the `ACCOUNTS`
  list in `accountRegistry.js` — miss it and `protect` cannot hydrate that account at all.
- **Cross-collection email uniqueness is application-enforced** (`isEmailRegistered`), so a race
  between two registrations in *different* collections is not stopped by an index. Keep the check
  before every insert/update that sets an email.
- **Avatars are base64 in Mongo, not object storage** — a deliberate, documented trade-off; the
  3 MB body limit is the practical ceiling. See the user-app `AUTH.md`.
- **Password policy** (8–64, upper/lower/digit/special) lives in `validators.js`, so a client can
  never relax it.
- OTPs carry expiry; the password-reset token is separate from and shorter-lived than an access token.

## 9. Known gotchas / regressions

- **`/resend-verification-otp` has no validator** while every sibling endpoint does. It reads
  `email` straight from the body — validate defensively in the controller, and treat this as the
  known asymmetry when adding endpoints.
- `requireManager` maps to the role string **`'admin'`**, and `requireAdmin` accepts
  `'admin'` *or* `'super-admin'`. Easy to invert; the names do not read the way the strings do.
- New account types must be registered in `accountRegistry.js` **and** given a role string that the
  guards expect.
- `protect` costs a DB read per request by design (fresh account state). Don't "optimise" it into
  trusting token claims.

## 10. Tests covering this module

| Layer | File | What it locks |
|---|---|---|
| Unit | `tests/…` | validators, `accountRegistry` resolution across the four models |
| Integration | `tests/integration/…` | register→verify→login, unverified 403 `requiresVerification`, refresh rotation, forgot/reset chain, profile + avatar (incl. oversize rejection), role-guard 401/403 matrix |

Canonical matrix: [`../TEST_PLAN_INTEGRATION.md`](../TEST_PLAN_INTEGRATION.md) and
[`../project/TEST_EDGE_CASES.md`](../project/TEST_EDGE_CASES.md).

## 11. Change protocol

See [`_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) §11. Auth touches **all three clients** —
a token/response-shape change must update every consuming app's auth doc in the same change.
