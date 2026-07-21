# Backend Docs Index

The documentation map for the TrackMe API. [`../CLAUDE.md`](../CLAUDE.md) routes you here.
**Modules** = "how does domain X work". **Guides** = "how do I do task Y". Everything else is
cross-cutting reference.

> New module docs start from [`guides/_MODULE_TEMPLATE.md`](guides/_MODULE_TEMPLATE.md) — the
> **backend variant** (route → middleware → controller → model), not the client-app one.
> [`modules/AUTH.md`](modules/AUTH.md) and [`modules/PRIVATE_ROUTES.md`](modules/PRIVATE_ROUTES.md)
> are the reference examples.

## Modules (per domain — start here)
- **[modules/AUTH.md](modules/AUTH.md)** — register/verify/login/Google, JWT + refresh, password
  reset, profile/avatar, the four-collection account model and role guards.
- **[modules/PRIVATE_ROUTES.md](modules/PRIVATE_ROUTES.md)** — room key (AES-GCM + HMAC), lockout,
  join approval, membership, socket enforcement.

The rest exist as **stubs** — the code ships, the doc doesn't yet. Each names its source files
and must be filled in from the template as part of the next change touching it:
[ROUTES](modules/ROUTES.md) · [CUSTOM_ROUTES](modules/CUSTOM_ROUTES.md) ·
[QR_ATTENDANCE](modules/QR_ATTENDANCE.md) · [REALTIME](modules/REALTIME.md) ·
[NOTIFICATIONS](modules/NOTIFICATIONS.md) · [BUSES](modules/BUSES.md) ·
[BOOKINGS](modules/BOOKINGS.md) · [ADMIN](modules/ADMIN.md) · [DRIVER](modules/DRIVER.md) ·
[ETA_TRANSIT](modules/ETA_TRANSIT.md)

## Guides (how to do a task)
- **[guides/ADDING_A_FEATURE.md](guides/ADDING_A_FEATURE.md)** — the ship-an-endpoint loop,
  including the cross-repo contract step.
- **[guides/ADDING_A_TEST.md](guides/ADDING_A_TEST.md)** — which layer, the serial-Mongo rules,
  and the mandatory authz cases.
- **[guides/RELEASING.md](guides/RELEASING.md)** — Render auto-deploy, migrations, tags, rollback.
- **[guides/_MODULE_TEMPLATE.md](guides/_MODULE_TEMPLATE.md)** — copy to start a module doc.

## Testing
- **[TESTING_GUIDE.md](TESTING_GUIDE.md)** — traceability table.
- **[QA_UPDATE_TRIGGERS.md](QA_UPDATE_TRIGGERS.md)** — when to update tests + docs.
- **[TEST_PLAN_UNIT.md](TEST_PLAN_UNIT.md)** / **[TEST_PLAN_INTEGRATION.md](TEST_PLAN_INTEGRATION.md)**
  / **[TEST_PLAN_E2E.md](TEST_PLAN_E2E.md)** — per-layer coverage plans.
- **[project/TEST_PLAN_INTEGRATION_DETAILED.md](project/TEST_PLAN_INTEGRATION_DETAILED.md)** — the
  detailed CRUD/edge matrix.
- **[project/TEST_EDGE_CASES.md](project/TEST_EDGE_CASES.md)** — edge cases worth locking.
- **[project/QA_TRACEABILITY_INDEX.md](project/QA_TRACEABILITY_INDEX.md)** — QA index.

> `TEST_PLAN_INTEGRATION.md` is the canonical integration/CRUD matrix cited by the client apps.

## Status & log
- **[CHANGES.md](CHANGES.md)** — append-only session log (write before every push).
- **[../CHANGELOG.md](../CHANGELOG.md)** — release history; breaking contract changes called out.
- **[PROGRESS.md](PROGRESS.md)** — phase rollup.
- **[SELF_CONTAINED_CHECKLIST.md](SELF_CONTAINED_CHECKLIST.md)** — standalone-readiness.
- **Enforcement:** [`../scripts/check-docs.mjs`](../scripts/check-docs.mjs) + `.githooks/pre-push`.
  Enable with `git config core.hooksPath .githooks`.

## Project / restructure history
- **[RESTRUCTURE_PLAN.md](RESTRUCTURE_PLAN.md)**, **[project/IMPLEMENTATION_RUNBOOK.md](project/IMPLEMENTATION_RUNBOOK.md)**,
  **[project/ROOT_STATE.md](project/ROOT_STATE.md)**, and the `project/PHASE_*.md` checklists —
  historical plans. Useful for "why is it like this", not as current-state truth.
