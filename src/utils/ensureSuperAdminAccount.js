const SuperAdmin = require('../models/SuperAdmin');

// Runs once on server boot. The database is the source of truth for the
// super-admin's credentials — this only ever creates the account on a fresh
// database (zero SuperAdmin documents) and never touches an existing one.
// No password is hardcoded here; it must come from env vars so nothing
// resembling a real credential is committed to source control.
const ensureSuperAdminAccount = async () => {
  const existingCount = await SuperAdmin.countDocuments();
  if (existingCount > 0) {
    return;
  }

  const email = process.env.SUPERADMIN_EMAIL;
  const password = process.env.SUPERADMIN_PASSWORD;

  if (!email || !password) {
    console.warn(
      'No super-admin account exists and SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD are not set. ' +
      'Skipping bootstrap — set both env vars and restart, or create one via scripts/create-admins.js.'
    );
    return;
  }

  await SuperAdmin.create({
    name: process.env.SUPERADMIN_NAME || 'Platform Super Admin',
    email: email.toLowerCase().trim(),
    password,
    isActive: true,
    isEmailVerified: true
  });

  console.log(`Super-admin account created for web-admin access: ${email.toLowerCase().trim()}`);
};

module.exports = ensureSuperAdminAccount;
