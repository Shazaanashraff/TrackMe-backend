# ADMIN (manager / super-admin) — TrackMe Backend

Manager and super-admin account management, bus requests, and the audit log. Every manager endpoint must scope to the caller's own resources.

**Status:** `PLANNED (doc)` — the code is shipped; **this document is not yet written**.
Do not treat its absence as "no such feature". Read the source below, then fill this file in
from [`../guides/_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) (backend variant) as part
of your next change here — that is the change protocol, not optional extra work.

## Source of truth until this doc exists

`src/routes/managerRoutes.js`, `src/routes/superAdminRoutes.js`, `src/controllers/managerController.js`, `src/controllers/superAdminController.js`, `src/models/ManagerAuditLog.js`, `src/models/ManagerBusRequest.js`

> `src/controllers/managerEnrollmentsController.js`'s passenger payload (`requestSummary`) also
> belongs in this doc once written — it now surfaces `passenger.account` (the owning identity's
> email/phone) for a managed rider profile, since that profile has no email of its own. See
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
