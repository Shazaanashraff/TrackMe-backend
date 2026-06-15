require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

// Simple CLI arg parsing: --key=value
const parseArgs = () => {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value;
    }
  });
  return args;
};

const args = parseArgs();

const SUPER_EMAIL = args.superEmail || process.env.SUPERADMIN_EMAIL || 'mohamedshazaan7@gmail.com';
const SUPER_PASSWORD = args.superPassword || process.env.SUPERADMIN_PASSWORD;
const MANAGER_EMAIL = args.managerEmail || process.env.MANAGER_EMAIL || 'manager@example.com';
const MANAGER_PASSWORD = args.managerPassword || process.env.MANAGER_PASSWORD;

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set. Set it in environment or .env');
  process.exit(1);
}

if (!SUPER_PASSWORD || !MANAGER_PASSWORD) {
  console.error('❌ Missing passwords. Provide --superPassword and --managerPassword or set env vars SUPERADMIN_PASSWORD and MANAGER_PASSWORD');
  process.exit(1);
}

const upsertUser = async ({ email, password, name, role }) => {
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    existing.name = name || existing.name;
    existing.role = role || existing.role;
    existing.password = password; // will be hashed by pre-save
    existing.isEmailVerified = true;
    existing.isActive = true;
    await existing.save();
    console.log(`🔁 Updated user: ${email} (role=${existing.role})`);
    return existing;
  }

  const created = await User.create({
    name: name || (role === 'super-admin' ? 'Super Admin' : 'Manager'),
    email,
    password,
    role,
    isEmailVerified: true,
    isActive: true
  });
  console.log(`✅ Created user: ${email} (role=${role})`);
  return created;
};

const run = async () => {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ MongoDB connected');

    // Super Admin
    await upsertUser({
      email: SUPER_EMAIL,
      password: SUPER_PASSWORD,
      name: 'Mohamed Shazaan',
      role: 'super-admin'
    });

    // Manager (role 'admin' used for manager endpoints)
    await upsertUser({
      email: MANAGER_EMAIL,
      password: MANAGER_PASSWORD,
      name: 'Platform Manager',
      role: 'admin'
    });

    console.log('\n--- Done ---');
    console.log(`Super-admin: ${SUPER_EMAIL}`);
    console.log(`Manager: ${MANAGER_EMAIL}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating users:', error);
    process.exit(1);
  }
};

run();
