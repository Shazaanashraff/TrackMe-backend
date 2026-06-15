# Phase D Backend Integration + Websocket Checklist (Docs Only)

Scope: full backend CRUD + websocket strategy against test DB.

## Global Rules
- Use MONGODB_TEST_URI.
- Seed and cleanup per suite.
- Validate role matrix for protected routes.
- Keep response shapes stable.

## Integration Coverage
- Auth flows: register, verify, login, refresh, password reset, logout, profile.
- User endpoints: bus reads, bookings, notifications, eta, bus-reviews.
- Driver endpoints: bus register/update, earnings.
- Web admin endpoints: routes CRUD, bus admin, manager and super-admin flows.
- Websocket flows: driver tracking, user route subscription, manager tracking, cross-actor updates.

## Verification
- npm run test:integration green.
- npm run test:ws green.
- docs/TEST_PLAN_INTEGRATION.md fully ticked.
