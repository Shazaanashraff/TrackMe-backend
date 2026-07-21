#!/usr/bin/env node
/**
 * check-docs.mjs — documentation staleness check.
 *
 * Warns (does not block, by default) when code changed but the docs that describe it
 * did not. Wired to .githooks/pre-push; also runnable by hand:
 *
 *   node scripts/check-docs.mjs                 # check unpushed commits vs upstream
 *   node scripts/check-docs.mjs --staged        # check staged changes
 *   node scripts/check-docs.mjs --range A..B    # check an explicit git range
 *   node scripts/check-docs.mjs --strict        # exit 1 on findings (block the push)
 *
 * Rules:
 *  1. src/ changed            → docs/CHANGES.md must have an entry in the same range.
 *  2. a module's code changed → that module's docs/modules/<NAME>.md should change too.
 *  3. tests changed           → docs/TESTING_GUIDE.md should change too.
 *
 * Keep the MODULES map in sync when you add a module doc.
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const staged = args.includes('--staged');
const rangeArg = args.find((a) => a.startsWith('--range'));

function git(...a) {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Path globs that belong to each module doc. A file may match several. */
const MODULES = [
  { doc: 'docs/modules/AUTH.md', label: 'auth', match: [
    /authController/, /authRoutes/, /^src\/middleware\/auth\./, /^src\/middleware\/validators\./,
    /accountRegistry/, /ensureSuperAdminAccount/,
    /^src\/models\/(User|Driver|Manager|SuperAdmin)\./,
  ]},
  { doc: 'docs/modules/PRIVATE_ROUTES.md', label: 'private-routes', match: [
    /routeAccessController/, /managerPrivateRoutesController/, /^src\/utils\/roomKey\./,
    /^src\/models\/(RouteMembership|RouteJoinRequest|RouteKeyAttempt)\./,
  ]},
  { doc: 'docs/modules/ROUTES.md', label: 'routes', match: [
    /routeController/, /routeGeometryController/, /routeRoutes/, /^src\/models\/Route\./,
  ]},
  { doc: 'docs/modules/CUSTOM_ROUTES.md', label: 'custom-routes', match: [
    /customRouteController/, /customRouteRoutes/, /^src\/utils\/(customRoute|roadSnap)\./,
    /^src\/models\/RouteChangeRequest\./,
  ]},
  { doc: 'docs/modules/QR_ATTENDANCE.md', label: 'qr-attendance', match: [
    /qrController/, /qrRoutes/, /attendanceController/, /attendanceRoutes/,
    /boardingController/, /driverBoardingRoutes/, /managerAttendanceController/,
    /^src\/utils\/qrToken\./, /^src\/models\/BoardingEvent\./,
  ]},
  { doc: 'docs/modules/REALTIME.md', label: 'realtime', match: [
    /^src\/socket\//, /^src\/models\/LiveLocation\./,
  ]},
  { doc: 'docs/modules/NOTIFICATIONS.md', label: 'notifications', match: [
    /notificationController/, /notificationRoutes/, /^src\/utils\/(pushHelper|notificationHelper)\./,
    /^src\/models\/Notification\./,
  ]},
  { doc: 'docs/modules/BUSES.md', label: 'buses', match: [
    /busController/, /busRoutes/, /busReviewController/, /busReviewRoutes/,
    /^src\/models\/(Bus|BusReview)\./,
  ]},
  { doc: 'docs/modules/BOOKINGS.md', label: 'bookings', match: [
    /bookingController/, /bookingRoutes/, /^src\/models\/Booking\./,
  ]},
  { doc: 'docs/modules/ADMIN.md', label: 'admin', match: [
    /managerController/, /managerRoutes/, /superAdminController/, /superAdminRoutes/,
    /^src\/models\/(ManagerAuditLog|ManagerBusRequest)\./,
  ]},
  { doc: 'docs/modules/DRIVER.md', label: 'driver', match: [
    /driverEarningsController/, /driverEarningsRoutes/, /^src\/models\/DriverEarnings\./,
  ]},
  { doc: 'docs/modules/ETA_TRANSIT.md', label: 'eta-transit', match: [
    /etaController/, /etaRoutes/, /transitController/, /transitRoutes/,
    /placesController/, /placesRoutes/, /walkController/, /^src\/utils\/geo\./,
  ]},
];

function changedFiles() {
  if (staged) return git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (rangeArg) {
    const range = rangeArg.includes('=') ? rangeArg.split('=')[1] : args[args.indexOf(rangeArg) + 1];
    return git('diff', '--name-only', range).split('\n').filter(Boolean);
  }
  // Default: everything not yet on the upstream branch.
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (upstream) return git('diff', '--name-only', `${upstream}...HEAD`).split('\n').filter(Boolean);
  // No upstream (new branch): fall back to the last commit.
  return git('diff', '--name-only', 'HEAD~1...HEAD').split('\n').filter(Boolean);
}

const files = changedFiles();
if (files.length === 0) process.exit(0);

const touched = (re) => files.some((f) => re.test(f));
const changedDoc = (doc) => files.includes(doc);

const srcChanged = files.some((f) => f.startsWith('src/'));
const findings = [];

// Rule 1 — session log
if (srcChanged && !changedDoc('docs/CHANGES.md')) {
  findings.push(
    'docs/CHANGES.md has no entry for this change.\n' +
    '     Add one (template at the top of the file) so the session is on the record.'
  );
}

// Rule 2 — module docs
for (const m of MODULES) {
  const hit = files.find((f) => f.startsWith('src/') || f.startsWith('scripts/')
    ? m.match.some((re) => re.test(f)) : false);
  if (hit && !changedDoc(m.doc)) {
    findings.push(
      `${m.label}: changed ${hit}\n` +
      `     but ${m.doc} was not updated. Refresh its Key files / Contracts / Status.`
    );
  }
}

// Rule 3 — testing guide
if (touched(/^tests\/|\.test\.js$/) && !changedDoc('docs/TESTING_GUIDE.md')) {
  findings.push(
    'tests changed but docs/TESTING_GUIDE.md was not updated.\n' +
    '     Every test needs a traceability row (and a QA_TRACEABILITY_INDEX entry).'
  );
}

// Rule 4 — cross-repo contract reminder (backend-specific).
if (files.some((f) => /^src\/(routes|controllers)\//.test(f) || /^src\/socket\//.test(f))) {
  findings.push(
    'routes/controllers/socket changed — this service is a contract for three clients.\n' +
    '     Confirm user-app / driver-app / web-admin module docs still match, and note the\n' +
    '     contract impact in the CHANGES.md entry (see guides/ADDING_A_FEATURE.md §4).'
  );
}

if (findings.length === 0) {
  console.log('✓ check-docs: docs look in sync with the code.');
  process.exit(0);
}

const bar = '─'.repeat(68);
console.error(`\n${bar}\n  DOCS CHECK — ${findings.length} thing(s) to look at\n${bar}`);
findings.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
console.error(
  `${bar}\n` +
  `  Guides: docs/guides/ADDING_A_FEATURE.md · ADDING_A_TEST.md\n` +
  (strict
    ? '  --strict is on: push blocked.\n'
    : '  This is a warning, not a block. Push proceeding.\n') +
  `${bar}\n`
);
process.exit(strict ? 1 : 0);
