# Phase B Restructure Checklist (Docs Only)

Scope: behavior-preserving refactors per app. No new features.

## Global Rules
- Centralize duplicated fetches before splitting screens.
- Extract helpers before adding tests.
- Keep response shapes stable.
- No cross-app imports.

## backend
- No structural rewrite. Safe fixes only when tests surface bugs.

## user-app
- Centralize fetches: createBooking uses parseResponse; add authHeaders; de-dupe offline detection.
- Split large screens: RouteSelectionScreen, LiveMapScreen(.web), UserProfileScreen, RegisterScreen.
- Add helpers: notificationUtils, route filter predicate, region-from-coords.

## driver-app
- Centralize fetches: getMyBus and getDriverEarningsHistory into hooks.
- Split large screens: DriverDashboard, DriverEarningsScreen, RouteManagementScreen, BusRegistrationScreen.
- Extract useLocationTracking hook.

## web-admin
- Implement helper refactor plan under src/helpers/.
- Split large pages: OperationsPage, DashboardPage, ManagerBusesPage, ManagerTrackingPage, ManagerDashboardPage, LoginPage.
- Keep api.js as thin endpoint map around helpers.

## Verification
- App boots after each refactor step.
- No behavior regressions in core flows.
- Update docs/TESTING_GUIDE.md when helper boundaries change.
