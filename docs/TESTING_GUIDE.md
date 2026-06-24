# Backend Testing Guide

This guide maps backend behaviors to tests and indicates when to update tests.

## Auth
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| POST /api/auth/register | integration | tests/integration/auth/register.test.js | valid, invalid, duplicate | payload or validation changes |
| POST /api/auth/login | integration | tests/integration/auth/login.test.js | valid, wrong password, unverified | auth flow changes |
| POST /api/auth/refresh-token | integration | tests/integration/auth/refresh.test.js | valid, invalid | token lifecycle changes |
| POST /api/auth/forgot-password/* | integration | tests/integration/auth/password-reset.test.js | request/verify/reset | otp or reset logic changes |
| PUT /api/auth/profile | integration | tests/integration/auth/profile.test.js | update profile, invalid fields | profile schema changes |

## Routes and Buses
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| /api/routes CRUD | integration | tests/integration/admin/routes.test.js | create, update, toggle, delete | route schema or admin rules change |
| /api/bus CRUD | integration | tests/integration/shared/buses.test.js | create, update, maintenance, delete | bus schema or status rules change |
| /api/bus/routes + /api/bus/route/:id | integration | tests/integration/shared/bus-reads.test.js | list + filter | filtering rules change |
| /api/bus/stops + /api/bus/routes/plan | integration + unit | tests/integration/journey-plan.test.js | stop list, direct A→B matching, direction filter, no-match, validation; geo helpers | journey-matching or geo logic changes |
| /api/places/* (autocomplete, details, reverse) | integration | tests/integration/places-proxy.test.js | input guards, 503 no-key, no key leak, reverse coord validation, reverse name-from-address derivation + fallback | proxy guards or reverse-geocode response shape change |

## Bookings and ETA
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| /api/bookings | integration | tests/integration/user/bookings.test.js | create, confirm, cancel | booking rules change |
| /api/eta/* | integration | tests/integration/user/eta.test.js | ETA calculations | ETA logic changes |

## Notifications
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| /api/notifications | integration | tests/integration/shared/notifications.test.js | list, read, delete | notification schema changes |

## Driver Earnings
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| /api/driver-earnings/* | integration | tests/integration/driver/earnings.test.js | stats, history, payout | earnings logic changes |

## Manager and Super Admin
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| /api/manager/* | integration | tests/integration/admin/manager.test.js | dashboards, bus updates, requests | manager workflow changes |
| /api/super-admin/* | integration | tests/integration/admin/super-admin.test.js | dashboards, reviews, audits, managers | admin workflow changes |

## Websocket
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| driver tracking events | ws integration | tests/integration/ws/driver-tracking.test.js | start, update, stop | socket event payload changes |
| user route subscription | ws integration | tests/integration/ws/user-route.test.js | join/leave/receive | rooming rules change |
| manager bus tracking | ws integration | tests/integration/ws/manager-track.test.js | join/leave/receive | manager role rules change |
