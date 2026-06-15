# Phase C Unit Tests Checklist (Docs Only)

Scope: unit tests for helpers, utilities, and frontend fetch layers.

## Global Rules
- Tests cover success and failure paths.
- Include edge cases: empty, null/undefined, 0 vs missing, invalid types.
- Update docs/TESTING_GUIDE.md for each new test file.

## backend
- Unit tests for middleware validators and utility helpers.

## user-app
- Unit tests for helpers and UI components.
- Fetch-layer verification for every api.js method with mocked fetch.

## driver-app
- Unit tests for helpers, sockets, and UI components.
- Fetch-layer verification for every api.js method with mocked fetch.

## web-admin
- Implement WEB_ADMIN_UNIT_TEST_STRATEGY using Vitest + RTL.
- Cover auth helpers, API request helpers, domain helpers, and page wiring.

## Verification
- npm run test:unit green per app.
- docs/TEST_PLAN_UNIT.md fully ticked.
