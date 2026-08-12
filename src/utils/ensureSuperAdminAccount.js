const SuperAdmin = require('../models/SuperAdmin');
const { findIdentityByEmail, createIdentityWithProfile } = require('./identityRegistry');

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
      'Skipping bootstrap — set both env vars and restart.'
    );
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  // A super-admin must own its email outright — sharing that login with a rider or a
  // manager would mean one leaked password reaches the highest-privilege account. Fail
  // loudly rather than quietly bootstrapping onto somebody's existing login.
  const existingIdentity = await findIdentityByEmail(normalizedEmail);
  if (existingIdentity) {
    console.error(
      `Refusing to bootstrap the super-admin: ${normalizedEmail} already has a TrackMe login. ` +
      'Set SUPERADMIN_EMAIL to a dedicated address that holds no other role.'
    );
    return;
  }

  await createIdentityWithProfile({
    email: normalizedEmail,
    password,
    isEmailVerified: true,
    isProvisional: true,
    role: 'super-admin',
    fields: {
      name: process.env.SUPERADMIN_NAME || 'Platform Super Admin',
      isActive: true,
      isEmailVerified: true
    }
  });

  console.log(`Super-admin account created for web-admin access: ${normalizedEmail}`);
};

module.exports = ensureSuperAdminAccount;
