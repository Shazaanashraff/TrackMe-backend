require('dotenv').config();
const mongoose = require('mongoose');
const SuperAdmin = require('../src/models/SuperAdmin');
const Manager = require('../src/models/Manager');

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

const upsertManager = async ({ email, password, name }) => {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await Manager.findOne({ email: normalizedEmail });
  if (existing) {
    existing.name = name || existing.name;
    existing.password = password; // will be hashed by pre-save
    existing.isEmailVerified = true;
    existing.isActive = true;
    await existing.save();
    console.log(`🔁 Updated manager: ${normalizedEmail}`);
    return existing;
  }

  const created = await Manager.create({
    name: name || 'Manager',
    email: normalizedEmail,
    password,
    isEmailVerified: true,
    isActive: true
  });
  console.log(`✅ Created manager: ${normalizedEmail}`);
  return created;
};

// Only one super-admin may ever exist. If one is already present under a
// different email, this refuses rather than silently creating a second.
const upsertSuperAdmin = async ({ email, password, name }) => {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await SuperAdmin.findOne({ email: normalizedEmail });
  if (existing) {
    existing.name = name || existing.name;
    existing.password = password;
    existing.isEmailVerified = true;
    existing.isActive = true;
    await existing.save();
    console.log(`🔁 Updated super-admin: ${normalizedEmail}`);
    return existing;
  }

  const anyExisting = await SuperAdmin.findOne();
  if (anyExisting) {
    throw new Error(
      `Refusing to create a second super-admin. One already exists: ${anyExisting.email}. ` +
      `Pass --superEmail=${anyExisting.email} to update it instead, or remove it first if this is intentional.`
    );
  }

  const created = await SuperAdmin.create({
    name: name || 'Super Admin',
    email: normalizedEmail,
    password,
    isEmailVerified: true,
    isActive: true
  });
  console.log(`✅ Created super-admin: ${normalizedEmail}`);
  return created;
};

const run = async () => {
  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ MongoDB connected');

    await upsertSuperAdmin({
      email: SUPER_EMAIL,
      password: SUPER_PASSWORD,
      name: 'Mohamed Shazaan'
    });

    await upsertManager({
      email: MANAGER_EMAIL,
      password: MANAGER_PASSWORD,
      name: 'Platform Manager'
    });

    console.log('\n--- Done ---');
    console.log(`Super-admin: ${SUPER_EMAIL}`);
    console.log(`Manager: ${MANAGER_EMAIL}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating users:', error.message);
    process.exit(1);
  }
};

run();
