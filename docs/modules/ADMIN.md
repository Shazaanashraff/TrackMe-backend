# ADMIN (manager / super-admin) — TrackMe Backend

Manager and super-admin account management, bus requests, and the audit log. Every manager endpoint must scope to the caller's own resources.

**Status:** `PLANNED (doc)` — the code is shipped; **this document is not yet written**.
Do not treat its absence as "no such feature". Read the source below, then fill this file in
from [`../guides/_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) (backend variant) as part
of your next change here — that is the change protocol, not optional extra work.

## Source of truth until this doc exists

`src/routes/managerRoutes.js`, `src/routes/superAdminRoutes.js`, `src/controllers/managerController.js`, `src/controllers/superAdminController.js`, `src/models/ManagerAuditLog.js`, `src/models/ManagerBusRequest.js`

> `src/controllers/managerEnrollmentsController.js`'s passenger payload (`requestSummary`) also
> belongs in this doc once written. It resolves who a request is for from the enrolment's
> **`studentId`** (a `RiderProfile`), falling back to the deprecated `userId` only for rows the
> legacy `/redeem` path wrote — resolving by `userId` alone showed `passenger: null` for every
> request the current app makes, because `createEnrollment` writes that field as null. The
> payload carries the rider's `name`, `riderCode`, `contactPhone`, `isManagedProfile` (true when
> the rider is not the account holder's own row), `account` (the owning account's name/email/phone)
> and `organizationValues` — the answers the rider gave that organization's enrolment form, which
> is what the manager is being asked to approve. Each row also carries `organization`
> (`{_id, name, serviceType}`, from the rider's organization profile, falling back to the driver's
> own organization for a legacy row) and `passenger.organizationDetails` — the same answers as an
> ordered `{key, label, value}` list, labelled through `normalizedEnrollmentConfig()` so an
> organization that never opened the form builder still gets the catalog's "Grade" rather than the
> storage key "grade". `organizationValues` stays as the raw map for anything reading by key. See
> [`PROFILES.md`](PROFILES.md) §6 and `tests/integration/manager-enrollments-managed-profile.test.js`.

## What this doc must cover

Follow the template's section order: Purpose · API surface (method/path/auth/controller) ·
Key files · Data model (indexes + invariants) · Request flow · **Authorization & security rules**
· Side effects (socket/push/external) · **Not visible in the API surface** · Gotchas ·
Tests · Change protocol.

Pay particular attention to:
- the **auth middleware** guarding each endpoint (`src/middleware/auth.js`), and ownership
  scoping beyond the role check;
- which **client apps consume it**, so a contract change updates their module docs too;
- any invariant enforced by a **Mongoose index** rather than controller code.
