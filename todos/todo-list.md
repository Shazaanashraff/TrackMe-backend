# Backend TODO Backlog

Pick order: priority then lowest number, among unchecked, not-in-flight, not-blocked rows whose `Dep`
are all `[x]`. Spec in `active/NNN-slug.md`. Tick `[x]` + `done: DATE <sha>` on close-out.

## Feature: QR Attendance (NEXT version) — cite docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md
| ✓ | ID | Slug | Pri | Dep | One-line |
|---|----|------|-----|-----|----------|
| [ ] | 001 | qr-attendance-foundation | P2 | — | Rotating signed QR token, BoardingEvent model, driver scan endpoint (BOARD/ALIGHT), Expo push, attendance aggregation |

> First entry in the backend todo flow. The QR foundation gates the user-app (090), driver-app (090),
> and web-admin (025) QR todos — implement this first.
