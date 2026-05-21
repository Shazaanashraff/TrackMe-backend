const User = require('../models/User');

const DEFAULT_SUPER_ADMIN = {
  name: 'Platform Super Admin',
  email: 'ShazaanAshraff@SuperAdmin.com',
  password: 'SuperAdmin@123'
};

const ensureSuperAdminAccount = async () => {
  const normalizedEmail = DEFAULT_SUPER_ADMIN.email.toLowerCase();

  const existing = await User.findOne({ email: normalizedEmail }).select('+password');

  if (!existing) {
    await User.create({
      name: DEFAULT_SUPER_ADMIN.name,
      email: normalizedEmail,
      password: DEFAULT_SUPER_ADMIN.password,
      role: 'super-admin',
      isActive: true,
      isEmailVerified: true
    });

    console.log('Super-admin account created for web-admin access.');
    return;
  }

  existing.name = existing.name || DEFAULT_SUPER_ADMIN.name;
  existing.role = 'super-admin';
  existing.isActive = true;
  existing.isEmailVerified = true;
  existing.password = DEFAULT_SUPER_ADMIN.password;
  await existing.save();

  console.log('Super-admin account verified and credentials refreshed.');
};

module.exports = ensureSuperAdminAccount;
