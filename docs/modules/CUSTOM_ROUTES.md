# CUSTOM ROUTES — TrackMe Backend

Driver-recorded routes: submission, road-snapping, manager approval, and rider-safe visibility. Audited as fully done (both phases).

**Status:** `PLANNED (doc)` — the code is shipped; **this document is not yet written**.
Do not treat its absence as "no such feature". Read the source below, then fill this file in
from [`../guides/_MODULE_TEMPLATE.md`](../guides/_MODULE_TEMPLATE.md) (backend variant) as part
of your next change here — that is the change protocol, not optional extra work.

## Source of truth until this doc exists

`src/routes/customRouteRoutes.js`, `src/controllers/customRouteController.js`, `src/utils/roadSnap.js`, `src/utils/customRoute.js`, `src/models/RouteChangeRequest.js`

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
