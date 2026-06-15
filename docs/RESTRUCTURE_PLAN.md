# Backend Restructure Plan (Docs Only)

## Scope
- Documentation-only pass. No code changes in this step.
- Follow the safe-fix policy: only fix real bugs surfaced by tests, avoid response-shape churn.

## Objectives
1. Preserve current behavior while preparing for integration and websocket test coverage.
2. Document how integration tests should be structured and seeded.
3. Document how websocket flows are validated end-to-end.

## Planned (No-Code) Structure Notes
- Integration tests live under tests/integration/ grouped by user, driver, admin, shared, ws.
- Websocket tests live under tests/integration/ws/ with socket.io-client.
- Test data seeding and cleanup strategy is documented in TEST_PLAN_INTEGRATION.md.

## Known Alignment Issues (Documentation Only)
- The planned service-type test suite references /api/route and /api/booking, while the server mounts /api/routes and /api/bookings. Align the test plan and test files during implementation.

## Guardrails
- Keep error response shapes stable.
- Keep role-gated routes consistent with middleware.
- Document any behavior changes in TESTING_GUIDE.md.
