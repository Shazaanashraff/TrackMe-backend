# Backend TODO Backlog

Pick order: priority then lowest number, among unchecked, not-in-flight, not-blocked rows whose `Dep`
are all `[x]`. Spec in `active/NNN-slug.md`. Tick `[x]` + `done: DATE <sha>` on close-out.

## Feature: QR Attendance — cite docs/features/qr-attendance/QR_SYSTEM.md
| ✓ | ID | Slug | Pri | Dep | One-line |
|---|----|------|-----|-----|----------|
| [x] | 001 | qr-attendance-foundation | P2 | — | done: 2026-07-18 — account-scoped QR token (reworked from the original membership-scoped draft), BoardingEvent model, manager qrEnabled toggle, driver scan endpoint (BOARD/ALIGHT), Expo push, attendance aggregation |

> First entry in the backend todo flow. The QR foundation gated the user-app (090), driver-app (090)
> todos, both now also complete. web-admin (025, manager attendance reports/analytics) remains open —
> out of scope for the core rider/driver loop.
