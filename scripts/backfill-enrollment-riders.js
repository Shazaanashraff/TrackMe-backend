// One-off migration: give every legacy DriverEnrollment the `studentId` the
// rider-profile split made mandatory.
//
// Why this matters, concretely: a rider watches their vehicle by passing
// `riderId` to `vehicle:subscribe`, and the API serves that from
// `enrollmentSummary`'s `riderId: enrollment.studentId`. A pre-split row has
// `studentId: null` and only `userId` set, so the client receives
// `riderId: null`, `useVehicleTracking` refuses to subscribe, and the rider can
// never see their vehicle — even while the driver is broadcasting normally.
// Nothing surfaces as an error; the map just stays empty forever.
//
// `migrate-rider-profiles.js` does NOT cover this. That one backfills
// `users.profileKind`; it never touches enrollments.
//
// Resolution rule: an enrollment belongs to the account in `userId`, so its
// rider is that account's RiderProfile. Accounts migrated from the pre-split
// world have exactly one, and it commonly reuses the account's own `_id`. A row
// is left ALONE (and reported) when the account has no profile, or has more
// than one — picking between siblings is a guess, and guessing here would
// silently attach one person's shuttle to another.
//
// Usage:
//   node scripts/backfill-enrollment-riders.js            (dry run — prints the plan)
//   node scripts/backfill-enrollment-riders.js --apply    (commits)
//   node scripts/backfill-enrollment-riders.js --verify   (post-run assertions)

require('dotenv').config();
const mongoose = require('mongoose');
const DriverEnrollment = require('../src/models/DriverEnrollment');
const RiderProfile = require('../src/models/RiderProfile');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

// --- Pure planning helper (unit-tested without a database) ---

const isMissing = (value) => value === null || value === undefined || value === '';

/**
 * Decides what to do with each enrollment.
 *
 * @param {Array} enrollments rows of { _id, studentId, userId }
 * @param {Map<string, string[]>} profilesByAccount accountId -> rider profile ids
 * @returns {{ updates: Array<{_id: any, studentId: string}>, skipped: Array<{_id: any, reason: string}> }}
 */
const planEnrollmentBackfill = (enrollments, profilesByAccount) => {
  const updates = [];
  const skipped = [];

  for (const enrollment of enrollments || []) {
    if (!isMissing(enrollment.studentId)) continue; // already correct — re-run safe

    const accountId = isMissing(enrollment.userId) ? null : String(enrollment.userId);
    if (!accountId) {
      skipped.push({ _id: enrollment._id, reason: 'no studentId and no userId — cannot attribute' });
      continue;
    }

    const profiles = (profilesByAccount && profilesByAccount.get(accountId)) || [];
    if (profiles.length === 0) {
      skipped.push({ _id: enrollment._id, reason: `account ${accountId} has no rider profile` });
      continue;
    }
    if (profiles.length > 1) {
      skipped.push({
        _id: enrollment._id,
        reason: `account ${accountId} has ${profiles.length} rider profiles — ambiguous, resolve by hand`
      });
      continue;
    }

    updates.push({ _id: enrollment._id, studentId: profiles[0] });
  }

  return { updates, skipped };
};

// --- Runner ---

const loadPlan = async () => {
  const enrollments = await DriverEnrollment.collection
    .find({ $or: [{ studentId: null }, { studentId: { $exists: false } }] })
    .project({ _id: 1, studentId: 1, userId: 1, status: 1 })
    .toArray();

  const accountIds = [...new Set(enrollments.map((e) => e.userId).filter(Boolean).map(String))];
  const profiles = accountIds.length
    ? await RiderProfile.collection
      .find({ accountId: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .project({ _id: 1, accountId: 1 })
      .toArray()
    : [];

  const profilesByAccount = new Map();
  for (const profile of profiles) {
    const key = String(profile.accountId);
    if (!profilesByAccount.has(key)) profilesByAccount.set(key, []);
    profilesByAccount.get(key).push(String(profile._id));
  }

  return { enrollments, ...planEnrollmentBackfill(enrollments, profilesByAccount) };
};

const runMigration = async (apply = APPLY) => {
  const { enrollments, updates, skipped } = await loadPlan();

  console.log('--- Enrollments missing studentId ---');
  console.log(`Found:            ${enrollments.length}`);
  console.log(`Will backfill:    ${updates.length}`);
  console.log(`Cannot resolve:   ${skipped.length}`);
  skipped.forEach((s) => console.log(`  SKIP ${s._id}: ${s.reason}`));

  if (!apply) {
    console.log('\nDry run complete. No changes were made. Re-run with --apply to commit.');
    return true;
  }

  for (const update of updates) {
    await DriverEnrollment.collection.updateOne(
      { _id: update._id },
      { $set: { studentId: new mongoose.Types.ObjectId(update.studentId) } }
    );
  }

  console.log(`\nMigration applied. Backfilled ${updates.length} enrollment(s).`);
  return true;
};

const runVerify = async () => {
  let ok = true;
  const fail = (msg) => {
    ok = false;
    console.error(`  FAIL ${msg}`);
  };

  console.log('--- Verifying enrollment rider backfill ---');

  // Only ACTIVE/PENDING rows can actually be watched, so those are the ones a
  // missing studentId genuinely breaks.
  const stillMissing = await DriverEnrollment.collection.countDocuments({
    status: { $in: ['ACTIVE', 'PENDING'] },
    $or: [{ studentId: null }, { studentId: { $exists: false } }]
  });
  if (stillMissing) fail(`${stillMissing} watchable enrollment(s) still have no studentId`);

  // A studentId pointing at a profile that does not exist would pass the check
  // above while still failing every subscribe.
  const rows = await DriverEnrollment.collection
    .find({ status: { $in: ['ACTIVE', 'PENDING'] }, studentId: { $ne: null } })
    .project({ _id: 1, studentId: 1 })
    .toArray();
  const profileIds = new Set(
    (await RiderProfile.collection.find({}).project({ _id: 1 }).toArray()).map((p) => String(p._id))
  );
  const dangling = rows.filter((r) => !profileIds.has(String(r.studentId)));
  if (dangling.length) fail(`${dangling.length} enrollment(s) reference a missing rider profile`);

  console.log(`  watchable enrollments: ${rows.length}`);
  console.log(ok ? '\nVerification passed.' : '\nVerification FAILED.');
  return ok;
};

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(
    `Connected to MongoDB${VERIFY ? ' — VERIFY MODE' : APPLY ? '' : ' — DRY RUN (pass --apply to commit)'}\n`
  );

  const ok = VERIFY ? await runVerify() : await runMigration();

  await mongoose.connection.close();
  if (!ok) process.exit(1);
};

module.exports = { planEnrollmentBackfill, runMigration, runVerify };

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
