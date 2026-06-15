# Detailed Integration Test Plan — Auth & Bookings

This file expands the integration plan with concrete test cases, payloads, and expected responses for the Auth and Bookings endpoints. Use these as the canonical cases to implement Jest + supertest suites.

Auth: POST /api/auth/login

- Case: Successful login
  - Payload: `backend/tests/mock.json` -> `login.valid`
  - Expected HTTP: 200
  - Expected body: `{ code: 'AUTH_OK', token: <string>, user: { id, email } }`

- Case: Invalid credentials
  - Payload: { email: 'nope@example.com', password: 'wrong' }
  - Expected HTTP: 401
  - Expected body: `{ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' }`

- Case: Missing fields
  - Payload: { email: 'user@example.com' }
  - Expected HTTP: 400
  - Expected body: `{ code: 'AUTH_MISSING_FIELDS', details: ['password'] }`

- Case: Malformed JSON
  - Payload: raw body `not-a-json`
  - Expected HTTP: 400
  - Expected body: `{ code: 'MALFORMED_JSON' }`

- Case: Token expiry (E2E)
  - Approach: issue a short-lived test token or mock clock; assert requests with expired token return 401 and `AUTH_TOKEN_EXPIRED`.


Bookings: POST /api/bookings

- Case: Create success
  - Payload: { userId, busId, seat }
  - Expected HTTP: 201
  - Expected body: `{ code: 'BOOKING_CREATED', data: { id, userId, busId, seat, status } }`

- Case: Missing fields
  - Payload: { userId }
  - Expected HTTP: 400
  - Expected body: `{ code: 'BOOKING_VALIDATION_ERROR', details: { missing: ['busId','seat'] } }

- Case: Seat conflict
  - Approach: create booking for seat X, then create again for same seat
  - Expected HTTP: 409
  - Expected body: `{ code: 'BOOKING_CONFLICT' }`

- Case: Concurrency / race
  - Approach: parallel requests for same seat; assert exactly one success and others 409

- Case: Invalid ID format when reading/updating
  - Payload: malformed id -> 400 with `RESOURCE_INVALID_ID`


Notes
- Keep the assertions strict: assert both HTTP status and `code` field.
- Load `backend/tests/mock.json` at test runtime and reset DB between test suites.
- For socket-related side-effects (booking triggers bus occupancy broadcasts), use `socket.io-client` to listen for expected events and assert payload shape and room routing.
