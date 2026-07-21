const SuperAdmin = require('../../src/models/SuperAdmin');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const User = require('../../src/models/User');
const {
  findAccountByEmail,
  findAccountById,
  isEmailRegistered,
} = require('../../src/utils/accountRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// accountRegistry is the single place that knows all four account types exist —
// login, protect, and every uniqueness check go through it instead of picking a
// model directly. These tests cover the cross-collection scanning/lookup logic.

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('accountRegistry', () => {
  test('findAccountByEmail finds a manager and returns its role', async () => {
    const manager = await Manager.create({
      name: 'Registry Manager', email: `reg-mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });

    const result = await findAccountByEmail(manager.email);
    expect(result).not.toBeNull();
    expect(result.role).toBe('admin');
    expect(String(result.doc._id)).toBe(String(manager._id));
  });

  test('findAccountByEmail finds a driver, a super-admin, and a rider by the same call', async () => {
    const driver = await Driver.create({
      name: 'Registry Driver', email: `reg-drv-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });
    const superAdmin = await SuperAdmin.create({
      name: 'Registry Super Admin', email: `reg-sa-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });
    const rider = await User.create({
      name: 'Registry Rider', email: `reg-user-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });

    await expect(findAccountByEmail(driver.email)).resolves.toMatchObject({ role: 'driver' });
    await expect(findAccountByEmail(superAdmin.email)).resolves.toMatchObject({ role: 'super-admin' });
    await expect(findAccountByEmail(rider.email)).resolves.toMatchObject({ role: 'user' });
  });

  test('findAccountByEmail returns null for an unregistered email', async () => {
    const result = await findAccountByEmail(`nobody-${Date.now()}@test.com`);
    expect(result).toBeNull();
  });

  test('findAccountByEmail honors a select option (e.g. +password)', async () => {
    const manager = await Manager.create({
      name: 'Select Manager', email: `reg-select-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });

    const withoutPassword = await findAccountByEmail(manager.email);
    expect(withoutPassword.doc.password).toBeUndefined();

    const withPassword = await findAccountByEmail(manager.email, { select: '+password' });
    expect(typeof withPassword.doc.password).toBe('string');
  });

  test('findAccountById looks up directly in the collection for the given role', async () => {
    const driver = await Driver.create({
      name: 'ById Driver', email: `reg-byid-drv-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    });

    const found = await findAccountById(driver._id, 'driver');
    expect(found).not.toBeNull();
    expect(found.role).toBe('driver');

    // Same _id, wrong role -> not found (accounts don't leak across collections).
    const notFound = await findAccountById(driver._id, 'admin');
    expect(notFound).toBeNull();
  });

  test('isEmailRegistered is true across every account type, not just one collection', async () => {
    const email = `reg-cross-${Date.now()}@test.com`;
    expect(await isEmailRegistered(email)).toBe(false);

    const manager = await Manager.create({ name: 'Cross Manager', email, password: 'P@ssw0rd!' });
    expect(await isEmailRegistered(email)).toBe(true);

    // excludeId lets an account's own update check pass without a false positive.
    expect(await isEmailRegistered(email, { excludeId: manager._id, excludeRole: 'admin' })).toBe(false);
  });
});
