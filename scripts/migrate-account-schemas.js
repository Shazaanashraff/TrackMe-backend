// One-off migration: splits the single `users` collection (role: driver/user/admin/
// super-admin) into four separate collections (SuperAdmin, Manager, Driver, User),
// and resolves any duplicate super-admin accounts along the way.
//
// Preserves each account's original _id, so every existing reference (Bus.managerId,
// Route.managerId, ManagerAuditLog.managerId, etc.) keeps resolving correctly without
// needing to touch those documents — only the Mongoose `ref:` metadata changed in code.
//
// Usage:
//   node scripts/migrate-account-schemas.js           (dry run — prints the plan, no writes)
//   node scripts/migrate-account-schemas.js --apply    (commits the migration)
//
// Optional env var: CANONICAL_SUPERADMIN_EMAIL — if more than one super-admin exists,
// this is the one kept (defaults to shazaanashraff@superadmin.com). The rest are moved
// to an `archived_accounts` collection, never deleted outright.

require('dotenv').config();
const mongoose = require('mongoose');
const SuperAdmin = require('../src/models/SuperAdmin');
const Manager = require('../src/models/Manager');
const Driver = require('../src/models/Driver');

const APPLY = process.argv.includes('--apply');
const CANONICAL_SUPERADMIN_EMAIL = String(
  process.env.CANONICAL_SUPERADMIN_EMAIL || 'shazaanashraff@superadmin.com'
).toLowerCase();

const stripRole = (doc) => {
  const { role, ...rest } = doc;
  return rest;
};

// Pure function so the dedup rule (prefer canonical email, else earliest created)
// can be unit tested without a live database.
const selectCanonicalSuperAdmin = (superAdminDocs, canonicalEmail) => {
  if (!superAdminDocs.length) {
    return { kept: null, archived: [] };
  }

  const sorted = [...superAdminDocs].sort(
    (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  const kept =
    sorted.find((d) => String(d.email).toLowerCase() === String(canonicalEmail).toLowerCase()) ||
    sorted[0];
  const archived = sorted.filter((d) => d._id.toString() !== kept._id.toString());

  return { kept, archived };
};

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to MongoDB${APPLY ? '' : ' — DRY RUN (pass --apply to commit)'}\n`);

  const usersCollection = mongoose.connection.collection('users');
  const allDocs = await usersCollection.find({}).toArray();

  const byRole = { 'super-admin': [], admin: [], driver: [], user: [] };
  const unknownRole = [];
  for (const doc of allDocs) {
    if (doc.role === undefined) {
      byRole.user.push(doc);
    } else if (byRole[doc.role]) {
      byRole[doc.role].push(doc);
    } else {
      unknownRole.push(doc);
    }
  }

  console.log('--- Current `users` collection breakdown ---');
  console.log(`super-admin: ${byRole['super-admin'].length}`);
  console.log(`admin (manager): ${byRole.admin.length}`);
  console.log(`driver: ${byRole.driver.length}`);
  console.log(`user (rider): ${byRole.user.length}`);
  if (unknownRole.length) {
    console.log(`UNKNOWN role (left in users, role field will still be dropped): ${unknownRole.length} -> ${unknownRole.map((d) => d.email).join(', ')}`);
  }

  // --- Super-admin dedup ---
  const { kept: keptSuperAdmin, archived: archivedSuperAdmins } = selectCanonicalSuperAdmin(
    byRole['super-admin'],
    CANONICAL_SUPERADMIN_EMAIL
  );

  console.log('\n--- Super-admin resolution ---');
  if (keptSuperAdmin) {
    console.log(`KEEP: ${keptSuperAdmin.email} (_id: ${keptSuperAdmin._id})`);
  } else {
    console.log('No super-admin account found in `users`.');
  }
  archivedSuperAdmins.forEach((d) => console.log(`ARCHIVE (duplicate): ${d.email} (_id: ${d._id})`));

  console.log('\n--- Plan ---');
  console.log(`Move ${byRole.admin.length} manager(s) -> managers collection`);
  console.log(`Move ${byRole.driver.length} driver(s) -> drivers collection`);
  console.log(`Move ${keptSuperAdmin ? 1 : 0} super-admin -> superadmins collection`);
  console.log(`Archive ${archivedSuperAdmins.length} duplicate super-admin(s) -> archived_accounts collection`);
  console.log(`Leave ${byRole.user.length + unknownRole.length} rider(s) in users collection (role field dropped)`);

  if (!APPLY) {
    console.log('\nDry run complete. No changes were made. Re-run with --apply to commit.');
    await mongoose.connection.close();
    return;
  }

  // --- Apply ---
  const managerDocs = byRole.admin.map(stripRole);
  const driverDocs = byRole.driver.map(stripRole);
  const superAdminDocs = keptSuperAdmin ? [stripRole(keptSuperAdmin)] : [];

  if (managerDocs.length) await Manager.collection.insertMany(managerDocs);
  if (driverDocs.length) await Driver.collection.insertMany(driverDocs);
  if (superAdminDocs.length) await SuperAdmin.collection.insertMany(superAdminDocs);

  if (archivedSuperAdmins.length) {
    const archiveDocs = archivedSuperAdmins.map((d) => ({
      ...d,
      _archivedAt: new Date(),
      _archivedReason: 'Duplicate super-admin account resolved during account-schema migration'
    }));
    await mongoose.connection.collection('archived_accounts').insertMany(archiveDocs);
  }

  const idsToRemove = [
    ...byRole.admin.map((d) => d._id),
    ...byRole.driver.map((d) => d._id),
    ...byRole['super-admin'].map((d) => d._id) // both kept + archived leave `users`
  ];
  if (idsToRemove.length) {
    await usersCollection.deleteMany({ _id: { $in: idsToRemove } });
  }

  // Drop the now-vestigial role field from every remaining doc (riders + any
  // unrecognized-role legacy docs, which become plain riders).
  await usersCollection.updateMany({}, { $unset: { role: '' } });

  console.log('\nMigration applied.');
  console.log(`  managers: +${managerDocs.length}`);
  console.log(`  drivers: +${driverDocs.length}`);
  console.log(`  superadmins: +${superAdminDocs.length}`);
  console.log(`  archived_accounts: +${archivedSuperAdmins.length}`);
  console.log(`  users: -${idsToRemove.length} moved out, role field dropped from the rest`);

  await mongoose.connection.close();
};

module.exports = { selectCanonicalSuperAdmin, stripRole };

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
