# Backend Integration Test Plan

## Test Harness
- Runner: Jest + supertest
- DB: dedicated Atlas test database via MONGODB_TEST_URI
- Websocket: socket.io-client against in-process server
- Cleanup: clear collections per suite and afterAll

## Coverage Matrix (CRUD + Auth + WS)
Each row requires: happy path, invalid input, unauthorized/wrong role, not found, empty/missing fields where applicable.

### Auth and Profile
| Endpoint | Cases |
|---|---|
| POST /api/auth/register | create user, invalid payload, duplicate email |
| POST /api/auth/verify-email | valid otp, invalid otp, expired otp |
| POST /api/auth/resend-verification-otp | resend allowed, invalid email |
| POST /api/auth/login | valid login, wrong password, unverified user |
| POST /api/auth/google | valid idToken, invalid idToken |
| POST /api/auth/refresh-token | valid refresh, expired/invalid refresh |
| POST /api/auth/forgot-password/request-otp | valid email, unknown email |
| POST /api/auth/forgot-password/verify-otp | valid otp, invalid otp |
| POST /api/auth/forgot-password/reset | valid reset, invalid token |
| POST /api/auth/logout | valid token, invalid token |
| PUT /api/auth/profile | update profile, invalid fields |

### User App Endpoints
| Endpoint | Cases |
|---|---|
| GET /api/bus/routes | list routes, filter serviceType |
| GET /api/bus/route/:routeId | list buses by route |
| GET /api/bus/:busId | read bus by id |
| GET /api/bus/list/all | pagination and filters |
| POST /api/bookings | create booking, no seats, invalid payload |
| GET /api/bookings/bus/:busId/available-seats | date variations |
| GET /api/bookings/bus/:busId/bookings | driver view list, role checks |
| GET /api/bookings/user/my-bookings | pagination |
| GET /api/bookings/admin/overview | admin summary and filters |
| GET /api/bookings/:bookingId | access control |
| PATCH /api/bookings/:bookingId/confirm-payment | payment confirmation |
| PATCH /api/bookings/:bookingId/cancel | cancel with reason |
| GET /api/notifications | list, pagination |
| GET /api/notifications/count/unread | count |
| GET /api/notifications/:notificationId | fetch one notification |
| PUT /api/notifications/:id/read | mark read |
| PUT /api/notifications/read-all | mark all |
| DELETE /api/notifications/:id | delete |
| DELETE /api/notifications/admin/cleanup | admin cleanup with role checks |
| POST /api/eta/calculate | calculate ETA payload validation |
| GET /api/eta/bus/:busId/route/:routeId | ETA calculation |
| GET /api/eta/route/:routeId/all-buses | route ETAs |
| POST /api/bus-reviews | create review |
| GET /api/bus-reviews/bus/:busId | list reviews |
| PUT /api/bus-reviews/:reviewId | update review |
| DELETE /api/bus-reviews/:reviewId | delete review |

### Driver App Endpoints
| Endpoint | Cases |
|---|---|
| POST /api/bus/register | register bus |
| GET /api/bus/my-bus | driver owns bus |
| PUT /api/bus/:busId | update bus (driver) |
| GET /api/driver-earnings/stats | stats |
| GET /api/driver-earnings/history | pagination |
| GET /api/driver-earnings/daily-breakdown | daily breakdown |
| GET /api/driver-earnings/:earningId | earning details |
| POST /api/driver-earnings/log-trip | system/admin logging path |
| PATCH /api/driver-earnings/:earningId/request-payout | payout request |

### Web Admin Endpoints
| Endpoint | Cases |
|---|---|
| GET /api/routes | read routes with filters |
| GET /api/routes/stats/overview | route stats overview |
| GET /api/routes/list/paginated | paginated route list |
| GET /api/routes/:routeId | route details |
| POST /api/routes | create route (admin) |
| PUT /api/routes/:routeId | update route |
| PATCH /api/routes/:routeId/toggle | toggle active |
| DELETE /api/routes/:routeId | delete route |
| GET /api/super-admin/dashboard | dashboard data |
| GET /api/super-admin/operations | overview |
| GET /api/super-admin/operations/:managerId | manager details |
| GET /api/super-admin/bus-requests | list requests |
| PATCH /api/super-admin/bus-requests/:requestId/review | approve/reject |
| GET /api/super-admin/audit-logs | audit listing |
| POST /api/super-admin/managers | create manager |
| GET /api/super-admin/managers | list managers |
| GET /api/super-admin/managers/:managerId | manager details |
| PUT /api/super-admin/managers/:managerId | update manager |
| PATCH /api/super-admin/managers/:managerId/status | toggle status |
| PATCH /api/super-admin/managers/:managerId/reset-password | reset password |
| PATCH /api/super-admin/managers/:managerId/assign-buses | assign buses |
| GET /api/manager/dashboard | manager dashboard |
| GET /api/manager/buses | manager buses |
| GET /api/manager/buses/:busId | manager bus detail |
| PUT /api/manager/buses/:busId | update manager bus |
| POST /api/manager/bus-accounts | create bus account request |
| PATCH /api/manager/bus-accounts/:busId/reset-password | reset bus account password |
| POST /api/manager/buses/:busId/delete-request | request delete |
| GET /api/manager/requests | list manager requests |
| GET /api/manager/buses/:busId/location | location history |
| PUT /api/bus/:busId | update bus (admin) |
| PATCH /api/bus/:busId/maintenance | maintenance toggle |
| DELETE /api/bus/:busId | delete bus |

### Websocket Coverage
| Flow | Cases |
|---|---|
| driver:start-tracking | marks bus active, joins room |
| driver:location | valid coords saved + broadcast, invalid coords rejected |
| driver:stop-tracking | marks bus inactive, broadcast status |
| user:join-route / leave-route | join/leave rooms |
| route:get-recent-locations | returns latest per active bus |
| manager:join-bus / leave-bus | role gating and ownership |
| cross-actor | driver update received by user and manager |
| connection lifecycle | connection-success, auth rejection, disconnect cleanup |
