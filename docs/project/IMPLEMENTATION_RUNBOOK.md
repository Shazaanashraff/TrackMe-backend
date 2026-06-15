# Implementation Runbook (Execution Detail)

This runbook turns the high-level plan into implementation steps with concrete output per phase.

## Phase A: Cleanup, Secrets, Self-Contained, Split

### A2 Cleanup execution order
1. Delete split-repos/ and commit.
2. Delete stale logs and commit.
3. Delete cache/build output folders and commit.
4. Delete empty folders and misleading root files and commit.
5. Verify font folder references, then delete uber-move-2-cufonfonts/ if unused and commit.
6. Remove one-off diagnostic scripts and commit.
7. Verify web-admin dead code references; remove dead files and methods and commit.

### A3 Secrets execution order
1. Untrack backend/.env and user-app/.env with git rm --cached.
2. Ensure each app .gitignore includes .env and env variants.
3. Ensure backend/.env.example and user-app/.env.example list all required keys.
4. Add rotation note in backend docs.
5. Commit secrets changes.

### A4 Self-contained execution order
1. Verify each app has README.md.
2. Verify each app has docs/README.md.
3. Verify each app has CLAUDE.md and .github/copilot-instructions.md.
4. Verify each app has .gitignore.
5. Verify no cross-app imports.
6. Commit per app.

### A5 Submodule split execution order
1. Confirm app remotes exist and are approved by owner.
2. Convert each app folder to submodule.
3. Create .gitmodules and commit.
4. Set root push.recurseSubmodules=on-demand.
5. Verify root and per-app push behavior.
6. Commit topology changes.

## Phase B: Restructure

### Backend
- Safe fixes only when tests fail due to real bugs.

### Driver App
1. Create useMyBus and migrate duplicate fetch calls.
2. Create useEarningsHistory and migrate duplicate fetch calls.
3. Split DriverDashboard.
4. Split DriverEarningsScreen.
5. Split RouteManagementScreen.
6. Split BusRegistrationScreen.
7. Commit each extraction separately.

### User App
1. Fix createBooking to use parseResponse and single body read.
2. Add authHeaders helper and replace repeated auth headers.
3. De-dupe backend offline error detection.
4. Split RouteSelectionScreen.
5. Split LiveMapScreen and LiveMapScreen.web.
6. Split UserProfileScreen.
7. Split RegisterScreen.
8. Commit each extraction separately.

### Web Admin
1. Implement shared auth/api helpers from testing refactor plan.
2. Move inline query-string logic to helper.
3. Move token read logic used by tracking page to helper.
4. Extract managers/routes/buses/tracking/operations/dashboard helper modules.
5. Split large pages into components.
6. Keep page files focused on state + handlers + render.
7. Commit each helper and page split separately.

## Phase C: Unit Tests

### Driver/User/Web Admin fetch-layer verification
- Create one API test file per app that mocks fetch.
- For each method verify URL, method, headers, body, query params.
- Verify success parse and failure parse behavior.

### Helper/component tests
- Add unit tests for every extracted helper.
- Add component tests for extracted components with edge-case props.

## Phase D: Backend Integration + WS

### Integration suite layout
- tests/integration/auth
- tests/integration/user
- tests/integration/driver
- tests/integration/admin
- tests/integration/shared
- tests/integration/ws

### Required suite behavior
- Seed only data needed for each suite.
- Cleanup modified collections after each test.
- Assert status code + payload shape + error shape.
- Add role-matrix negative tests for protected routes.

### Websocket suite behavior
- Test auth handshake success/failure.
- Test driver:start-tracking, driver:location, driver:stop-tracking.
- Test join-route/leave-route and route:get-recent-locations.
- Test manager:join-bus/leave-bus role and ownership checks.
- Test cross-actor broadcast delivery.
- Test disconnect cleanup behavior.

## Phase E: E2E

### User App
- Auth flows, booking flow, live map flow, notifications, profile.

### Driver App
- Auth flow, registration flow, tracking flow, earnings flow.

### Web Admin
- Super-admin managers CRUD, operations review/edit flow, routes flow.
- Manager bus request flow and tracking flow.

## Gate checklist by phase
- Gate A: root shape, cleanup complete, secrets untracked, apps self-contained.
- Gate B: apps boot and core flows smoke-pass.
- Gate C: test:unit green per app.
- Gate D: backend integration and websocket suites green.
- Gate E: test:e2e green per frontend.
