# CHANGES — backend session log

Append-only running log of what each work session changed. **Newest entry on top.**
The pre-push check ([`scripts/check-docs.mjs`](../scripts/check-docs.mjs)) expects a new entry
when source under `src/` changed. One entry per session/PR is enough.

**Before you push, add an entry using this template:**

```md
## YYYY-MM-DD — <short title>
- **Branch:** <branch>
- **Modules touched:** <e.g. private-routes, auth — link docs/modules/*>
- **What changed:** <1–4 bullets, plain English>
- **Why:** <the reason / ticket / todo id>
- **Contract impact:** <none | which endpoint/socket payload changed + which client docs updated>
- **Tests:** <added/updated files, incl. the authz cases — or "none — docs only">
- **Docs updated:** <docs/modules/*.md, TESTING_GUIDE row, consuming app docs — or "n/a">
- **Migration:** <script + whether it must run before deploy — or "none">
- **Follow-ups / known issues:** <or "none">
```

Feeds [`CHANGELOG.md`](../CHANGELOG.md) / release notes — see [`guides/RELEASING.md`](guides/RELEASING.md).

---

## 2026-07-22 — Documentation system (backend variant)
- **Branch:** main
- **Modules touched:** docs only (no `src/` change)
- **What changed:**
  - `CLAUDE.md` rewritten as a **router** (architecture overview, mounted API surface, the
    four-collection account model, non-negotiables).
  - Added the **backend variant** `docs/guides/_MODULE_TEMPLATE.md` — route→middleware→controller
    →model, with API-surface, data-model, authorization, side-effects and
    "not visible in the API surface" sections.
  - Added `docs/modules/`: `AUTH.md`, `PRIVATE_ROUTES.md`.
  - Added `docs/guides/`: `ADDING_A_FEATURE.md`, `ADDING_A_TEST.md`, `RELEASING.md`.
  - Added this `CHANGES.md` + `CHANGELOG.md`; rewrote `docs/README.md` as a grouped index.
  - Added `scripts/check-docs.mjs` + `.githooks/pre-push`.
- **Why:** mirror the user-app docs system so a session lands on the right file fast, and make
  cross-repo contract changes an explicit, checked step.
- **Contract impact:** none — docs only. (Documenting them surfaced that user-app's
  `PRIVATE_ROUTES.md` had **wrong endpoint paths**; corrected there to the real
  `POST /api/routes/join/verify`, `GET /api/routes/my-requests`,
  `DELETE /api/routes/:routeId/membership`.)
- **Tests:** none — docs only.
- **Docs updated:** this is the docs work.
- **Migration:** none.
- **Follow-ups / known issues:**
  - Run `git config core.hooksPath .githooks` once per clone.
  - Remaining module docs to write: ROUTES, CUSTOM_ROUTES, QR_ATTENDANCE, REALTIME,
    NOTIFICATIONS, BUSES, BOOKINGS, ADMIN, DRIVER, ETA_TRANSIT.
  - `POST /api/auth/resend-verification-otp` has no validator while every sibling does —
    documented in `modules/AUTH.md` §9, worth fixing.
