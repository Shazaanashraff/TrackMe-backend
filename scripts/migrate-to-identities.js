// One-off migration: extracts credentials from the four account collections
// (users, drivers, managers, superadmins) into a shared `identities` collection, and
// links each account document back to its Identity via `identityId`.
//
// After this runs, one email = one person, and that person may hold several role
// profiles (a rider who also drives). Before it runs, an email could only ever be one
// kind of account. See docs/modules/AUTH.md.
//
// Preserves every account document's original `_id`, so all existing references
// (Bus.driverId, Bus.managerId, Route.managerId, RouteMembership.userId,
// ManagerAuditLog.managerId, …) keep resolving untouched — same guarantee the earlier
// migrate-account-schemas.js made.
//
// Usage:
//   node scripts/migrate-to-identities.js            (dry run — prints the plan, no writes)
//   node scripts/migrate-to-identities.js --apply     (commits the migration)
//   node scripts/migrate-to-identities.js --verify     (post-run integrity assertions)
//
// SAFETY: passwords are copied as ALREADY-HASHED strings through the raw driver,
// deliberately bypassing Mongoose. Saving them through a model would re-run the
// bcrypt pre-save hook, double-hash every password, and lock every user out.

require('dotenv').config();
const mongoose = require('mongoose');
const Identity = require('../src/models/Identity');
const User = require('../src/models/User');
const Driver = require('../src/models/Driver');
const Manager = require('../src/models/Manager');
const SuperAdmin = require('../src/models/SuperAdmin');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

// Mirrors accountRegistry's ACCOUNTS precedence.
const ROLE_MODELS = [
  { role: 'super-admin', model: SuperAdmin },
  { role: 'admin', model: Manager },
  { role: 'driver', model: Driver },
  { role: 'user', model: User }
];

// --- Pure planning helpers (unit-tested without a database) ---

// Buckets every account document by its lowercased email.
const groupAccountsByEmail = (accountsByRole) => {
  const groups = new Map();

  for (const { role, docs } of accountsByRole) {
    for (const doc of docs || []) {
      const email = String(doc.email || '').trim().toLowerCase();
      if (!email) continue;
      if (!groups.has(email)) groups.set(email, []);
      groups.get(email).push({ role, doc });
    }
  }

  return groups;
};

// Decides, for each email, which document's credentials become the Identity's.
//
// Today emails are globally unique, so every group should hold exactly one member and
// this is a clean 1:1 mapping. A group with more than one member means the data already
// contains a shared email; that is mergeable ONLY if the credentials are unambiguous.
const planIdentities = (groups) => {
  const identities = [];
  const conflicts = [];
  const superAdminViolations = [];
  const alreadyMigrated = [];

  for (const [email, members] of groups) {
    // A super-admin must never share a login. Refuse to merge rather than quietly
    // granting a rider's password access to the highest-privilege account.
    if (members.length > 1 && members.some((m) => m.role === 'super-admin')) {
      superAdminViolations.push({ email, roles: members.map((m) => m.role) });
      continue;
    }

    if (members.every((m) => m.doc.identityId)) {
      alreadyMigrated.push({ email, roles: members.map((m) => m.role) });
      continue;
    }

    const withPassword = members.filter((m) => m.doc.password);
    const distinctHashes = new Set(withPassword.map((m) => m.doc.password));

    if (distinctHashes.size > 1) {
      // Two different bcrypt hashes cannot be reconciled — picking one would silently
      // change somebody's password. Needs a human.
      conflicts.push({
        email,
        reason: 'multiple different passwords across roles',
        roles: members.map((m) => m.role)
      });
      continue;
    }

    const googleIds = new Set(members.map((m) => m.doc.googleId).filter(Boolean));
    if (googleIds.size > 1) {
      conflicts.push({
        email,
        reason: 'multiple different googleIds across roles',
        roles: members.map((m) => m.role)
      });
      continue;
    }

    const credentialSource = withPassword[0] || members[0];

    identities.push({
      email,
      // Already a bcrypt digest — must not be re-hashed on the way in.
      password: credentialSource.doc.password || null,
      googleId: [...googleIds][0] || null,
      // A merged group takes the most permissive verification state; for the normal
      // single-member group this is simply that member's own flag.
      isEmailVerified: members.some((m) => m.doc.isEmailVerified === true),
      // Carry in-flight OTP / reset state across so a verification or reset that is
      // mid-flight when the migration runs does not break.
      emailVerification: credentialSource.doc.emailVerification || {},
      passwordReset: credentialSource.doc.passwordReset || {},
      createdAt: credentialSource.doc.createdAt || new Date(),
      members: members.map((m) => ({ role: m.role, _id: m.doc._id }))
    });
  }

  return { identities, conflicts, superAdminViolations, alreadyMigrated };
};

// --- Runner ---

const loadAccounts = async () =>
  Promise.all(
    ROLE_MODELS.map(async ({ role, model }) => ({
      role,
      model,
      // Raw driver read: `password` and the OTP fields are `select: false` on the
      // models, and we need them verbatim.
      docs: await model.collection.find({}).toArray()
    }))
  );

const runMigration = async () => {
  const accountsByRole = await loadAccounts();

  console.log('--- Current account collections ---');
  for (const { role, model, docs } of accountsByRole) {
    console.log(`${role.padEnd(12)} (${model.collection.name}): ${docs.length}`);
  }

  const groups = groupAccountsByEmail(accountsByRole);
  const plan = planIdentities(groups);

  console.log('\n--- Plan ---');
  console.log(`Distinct emails:            ${groups.size}`);
  console.log(`Identities to create:        ${plan.identities.length}`);
  console.log(`Already migrated (skipped): ${plan.alreadyMigrated.length}`);
  console.log(`Conflicts (blocking):       ${plan.conflicts.length}`);
  console.log(`Super-admin violations:     ${plan.superAdminViolations.length}`);

  const shared = plan.identities.filter((i) => i.members.length > 1);
  if (shared.length) {
    console.log(`\nEmails already held by more than one role (will merge into one identity):`);
    shared.forEach((i) => console.log(`  ${i.email} -> ${i.members.map((m) => m.role).join(', ')}`));
  }

  if (plan.conflicts.length || plan.superAdminViolations.length) {
    console.error('\n!!! ABORTING — resolve these by hand first.');
    plan.conflicts.forEach((c) => console.error(`  CONFLICT ${c.email}: ${c.reason} (${c.roles.join(', ')})`));
    plan.superAdminViolations.forEach((v) =>
      console.error(`  SUPER-ADMIN SHARED ${v.email}: ${v.roles.join(', ')} — give the super-admin a dedicated email`)
    );
    return false;
  }

  if (!APPLY) {
    console.log('\nDry run complete. No changes were made. Re-run with --apply to commit.');
    return true;
  }

  // --- Apply ---
  const identityDocs = [];
  const linkOps = new Map(ROLE_MODELS.map(({ role }) => [role, []]));
  const now = new Date();

  for (const planned of plan.identities) {
    const _id = new mongoose.Types.ObjectId();

    const doc = {
      _id,
      email: planned.email,
      isEmailVerified: planned.isEmailVerified,
      isProvisional: false,
      emailVerification: planned.emailVerification,
      passwordReset: planned.passwordReset,
      createdAt: planned.createdAt,
      updatedAt: now,
      __v: 0
    };
    // Omit rather than write null: the unique index on googleId is sparse, and a
    // literal null would make every password-only identity collide.
    if (planned.password) doc.password = planned.password;
    if (planned.googleId) doc.googleId = planned.googleId;

    identityDocs.push(doc);

    for (const member of planned.members) {
      linkOps.get(member.role).push({
        updateOne: { filter: { _id: member._id }, update: { $set: { identityId: _id } } }
      });
    }
  }

  if (identityDocs.length) {
    // Raw insertMany — no Mongoose, no pre-save hook, no re-hashing.
    await Identity.collection.insertMany(identityDocs);
  }

  for (const { role, model } of ROLE_MODELS) {
    const ops = linkOps.get(role);
    if (ops.length) await model.collection.bulkWrite(ops);
  }

  console.log('\nMigration applied.');
  console.log(`  identities: +${identityDocs.length}`);
  for (const { role, model } of ROLE_MODELS) {
    console.log(`  ${role.padEnd(12)} linked: ${linkOps.get(role).length} (${model.collection.name})`);
  }
  return true;
};

const runVerify = async () => {
  let ok = true;
  const fail = (msg) => {
    ok = false;
    console.error(`  FAIL ${msg}`);
  };

  console.log('--- Verifying identity migration ---');

  for (const { role, model } of ROLE_MODELS) {
    const orphans = await model.collection.countDocuments({ identityId: { $exists: false } });
    if (orphans) fail(`${orphans} ${role} document(s) have no identityId`);

    const dangling = await model.collection
      .aggregate([
        { $match: { identityId: { $exists: true } } },
        { $lookup: { from: Identity.collection.name, localField: 'identityId', foreignField: '_id', as: 'identity' } },
        { $match: { identity: { $size: 0 } } },
        { $count: 'n' }
      ])
      .toArray();
    if (dangling[0]?.n) fail(`${dangling[0].n} ${role} document(s) point at a missing identity`);

    const drifted = await model.collection
      .aggregate([
        { $match: { identityId: { $exists: true } } },
        { $lookup: { from: Identity.collection.name, localField: 'identityId', foreignField: '_id', as: 'identity' } },
        { $unwind: '$identity' },
        { $match: { $expr: { $ne: ['$email', '$identity.email'] } } },
        { $count: 'n' }
      ])
      .toArray();
    if (drifted[0]?.n) fail(`${drifted[0].n} ${role} document(s) have an email that no longer mirrors their identity`);
  }

  const identityIds = await Identity.collection.distinct('_id');
  let childless = 0;
  let sharedWithSuperAdmin = 0;
  for (const id of identityIds) {
    const roles = [];
    for (const { role, model } of ROLE_MODELS) {
      // eslint-disable-next-line no-await-in-loop
      if (await model.collection.findOne({ identityId: id }, { projection: { _id: 1 } })) roles.push(role);
    }
    if (!roles.length) childless += 1;
    if (roles.includes('super-admin') && roles.length > 1) sharedWithSuperAdmin += 1;
  }
  if (childless) fail(`${childless} identity/identities have no profile at all`);
  if (sharedWithSuperAdmin) fail(`${sharedWithSuperAdmin} identity/identities mix super-admin with another role`);

  console.log(`  identities: ${identityIds.length}`);
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

module.exports = { groupAccountsByEmail, planIdentities };

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
