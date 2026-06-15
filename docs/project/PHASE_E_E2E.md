# Phase E E2E Checklist (Docs Only)

Scope: Playwright E2E for all three frontends.

## Global Rules
- Use seeded test data and test DB.
- Mock native modules for Expo web flows.
- Keep assertions focused on user-visible outcomes.

## user-app
- Auth flows, bookings, live map updates, notifications, profile edits.

## driver-app
- Auth, bus registration, tracking, earnings.

## web-admin
- Super-admin flows: managers CRUD, operations review, routes.
- Manager flows: bus requests, tracking page.

## Verification
- npm run test:e2e green per app.
- docs/TEST_PLAN_E2E.md fully ticked.
