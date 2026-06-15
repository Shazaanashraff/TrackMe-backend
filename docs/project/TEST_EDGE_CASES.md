# CRUD Edge Cases & Test Guidance

This document lists required edge-case tests for all major CRUD surfaces (Auth, Bookings, Buses, Routes, Notifications, ETA, DriverEarnings, Reviews) and specifies expectations for responses, error codes, and E2E behaviours. Use `backend/tests/mock.json` as canonical fixture data; stress-test TTL is set to 86400 seconds (1 day) via `meta.ttl_seconds`.

Principles
- Always assert shape: JSON response includes `code` (string), `message` (human), and optional `details` (object/array) on errors.
- Map failure classes to HTTP codes and verify both code and message in tests: 400/422 for validation, 401 for auth, 403 for permission, 404 for not found, 409 for conflicts, 429 for rate-limits, 500/503 for server/db failures.
- For each CRUD operation include: valid success, invalid input (field missing/type), unauthorized, forbidden (role), not-found, duplicate/conflict, large/payload boundary, malformed JSON, concurrent updates, and simulated DB errors.

Per-resource Edge Cases (integration + unit + E2E pointers)

Auth / Login
- Success: valid credentials -> 200 + token
- Invalid credentials: 401 + code `AUTH_INVALID_CREDENTIALS`
- Missing fields: 400 + `AUTH_MISSING_FIELDS` (verify which fields)
- Malformed JSON: 400 + `MALFORMED_JSON`
- Rate limit: 429 + `AUTH_RATE_LIMIT`
- Token expiry: 401 when using expired token (E2E simulate clock skew / short-lived token)
- Server crash / DB down: 503 + `SERVICE_UNAVAILABLE`
- Tests: unit test controller validation; integration test full login flow and token usage; E2E test UI login, token persistence, token expiry handling.

Bookings (create/read/update/delete)
- Create: missing userId/busId -> 400 `BOOKING_VALIDATION_ERROR`
- Create: seat already taken -> 409 `BOOKING_CONFLICT`
- Create: invalid seat number (negative, zero, >capacity) -> 422
- Read: invalid id format -> 400; not found -> 404
- Update: simultaneous seat allocation (race) -> test with concurrent requests; expect one 200 and one 409
- Delete: unauthorized actor -> 403; admin cleanup path -> 200
- Large payloads and extra fields: ignored but should validate types
- Tests: unit test validation and service logic; integration test concurrent booking attempts and DB constraint behaviors; E2E test booking flow and UI feedback for failure codes.

Buses
- Create/update: invalid routeId -> 422 or 400
- Read list: pagination edge (page=0, page>max) -> 400/empty list
- Delete: bus with active bookings -> 409 or prevented; expected code `BUS_DELETE_CONFLICT`
- Tests: validate schema enforcement, broadcast side-effects (socket events) on updates.

Routes
- Create: duplicate name -> 409
- Read: geo/stop arrays empty -> 422
- Stats endpoints: boundary times (DST, leap seconds) -> verify deterministic results

Notifications
- Create: missing recipient -> 400
- Fetch single: not found -> 404
- Admin cleanup: permissions -> 403 for non-admin; idempotent DELETE -> 200

ETA Calculation (POST /api/eta/calculate)
- Invalid coordinates or missing fields -> 400
- Extremely large distances or nonsensical inputs -> validate 422 or fallback error
- Timeouts: the service should return 503 if downstream routing service times out; tests must stub/timeout dependencies

Driver Earnings
- Create/log-trip: missing driverId or malformed amounts -> 400
- Currency mismatches: validate currency format -> 422

Reviews
- Rate-limits on reviews per user/bus -> 429
- Invalid rating values (0, 6) -> 422

Common Edge Cases Across CRUD
- Malformed JSON payload -> 400 + `MALFORMED_JSON`
- Missing/extra fields -> 400 with validation details
- Invalid IDs (wrong format) -> 400
- Not found -> 404 with `RESOURCE_NOT_FOUND`
- Permission checks -> 403 with `FORBIDDEN`
- Conflict/duplicate -> 409 with `CONFLICT`
- Rate limits -> 429 with `RATE_LIMITED`
- Simulated DB failure -> 500/503 with `SERVICE_UNAVAILABLE`
- Ensure tests assert both HTTP status and structured error `code` and `message`.

Test Implementation Notes
- Use `backend/tests/mock.json` for deterministic payloads. Load fixtures before test runs; clear DB after each test or use transactional test DB where possible.
- Integration tests (Jest + supertest): spin a test server, stub external dependencies (maps, routing), assert DB state after operations, and verify socket broadcasts with `socket.io-client` when relevant.
- Unit tests: mock DB models (Mongoose) and test controllers/services in isolation; assert thrown errors map to standard error responses.
- E2E (Playwright): assert UI maps API error `code` -> shown user message; test token expiry/refresh and retry flows.
- Stress tests: run high concurrency booking flows using load tools (k6 or artillery). Use `meta.ttl_seconds` = 86400 for fixture expiry in stress harness. Validate DB cleanup post-run.

Assertions expected in every test
- HTTP status
- Response body includes `code` (machine token), `message` (human), and optional `details`
- DB side-effects (record created/updated/deleted) or absence thereof on failures
- Socket emissions (when applicable)

How to extend
- When adding new endpoints, append the endpoint and the CRUD edge-case rows to this file and to `backend/docs/project/TEST_PLAN_INTEGRATION.md` (if present) so the integration matrix stays authoritative.
