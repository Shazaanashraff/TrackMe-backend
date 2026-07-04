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
| /api/places/* (autocomplete, details, reverse) | integration | tests/integration/places-proxy.test.js | input guards, 503 no-key, no key leak, reverse coord validation, reverse name derivation: Google address_components (road/POI > town) + OSM structured + fallback | proxy guards or reverse-geocode name logic change |
| /api/transit/plan (normalize, group, prune, classify) | integration | tests/integration/transit.test.js | leg extraction, interchangeable-bus grouping, redundant pruning, service classification (local/express/long-distance by line name + stop spacing) + local-first ordering, guards | transit normalisation, classification list, or ordering change |

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

## Custom Routes (School/Work Shuttles)
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| geo helpers: pointToSegmentMeters, minDistanceToPolylineMeters, deviationStats | unit | tests/integration/custom-route-geo.test.js | on-segment, off-segment, degenerate polyline/breadcrumb, off-route threshold | deviation math or off-route thresholds change |
| roadSnap: encode/decodePolyline, downsample, snapToRoads | unit | tests/integration/custom-route-road-snap.test.js | round-trip encoding, jitter downsampling, batching >100 pts, missing-key/API-error fallback | snap batching, fallback behavior, or polyline format changes |
| Custom-route provisioning, recording, naming, visibility | integration | tests/integration/custom-routes.test.js | CUSTOM request provisions a PRIVATE PENDING_NAMING route; POST /api/driver/custom-routes/record fills+snaps; ownership 404s; PATCH .../name activates; manager-scoped list/dropdown; PRIVATE route absent from /api/routes, /api/routes/:id, /api/bus/routes, /api/bus/route/:id, /api/bus/stops, /api/bus/routes/:id/path, and cross-manager bus updates | custom-route flow, provisioning, or visibility filtering changes |
| Off-route detection + resolve (Phase 2): report-journey, record-update, resolve | integration | tests/integration/route-change-requests.test.js | on-route journey not flagged; sustained off-route journey flags + creates exactly one RouteChangeRequest + notification; dedupe (no 2nd PENDING while one exists); record-update creates/updates a candidate with stops; resolve KEEP_OLD leaves geometry untouched, ADOPT_NEW overwrites pathPolyline/stops/distance; idempotent double-resolve; cross-manager 404; invalid resolution 400 | deviation thresholds, RouteChangeRequest lifecycle, or resolve logic changes |

## Websocket
| Item | Test type | Test file | Cases covered | Update when |
|---|---|---|---|---|
| driver tracking events | ws integration | tests/integration/ws/driver-tracking.test.js | start, update, stop | socket event payload changes |
| join-route / route:get-recent-locations visibility | ws integration | tests/integration/ws/custom-route-visibility.test.js | PRIVATE route rejected from join-route and get-recent-locations; PUBLIC route allowed | socket visibility rules change |
| user route subscription | ws integration | tests/integration/ws/user-route.test.js | join/leave/receive | rooming rules change |
| manager bus tracking | ws integration | tests/integration/ws/manager-track.test.js | join/leave/receive | manager role rules change |
