# Backend E2E Plan

Backend behavior is validated through integration tests and frontend E2E flows.
This file tracks cross-service expectations that must be asserted in frontend E2E specs.

| Flow | Frontend E2E spec | Backend expectation |
|---|---|---|
| Booking flow | user-app e2e/booking.spec.js | booking create, seat validation, confirmation |
| Live tracking | user-app e2e/live-map.spec.js | socket updates broadcast |
| Driver tracking | driver-app e2e/tracking.spec.js | start/stop tracking updates bus status |
| Admin operations | web-admin e2e/operations.spec.js | review requests updates audit log |
