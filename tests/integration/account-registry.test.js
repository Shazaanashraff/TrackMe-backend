const Driver = require('../../src/models/Driver');
const Identity = require('../../src/models/Identity');
const Manager = require('../../src/models/Manager');
const User = require('../../src/models/User');
const { findAccountById } = require('../../src/utils/accountRegistry');
const {
  findIdentityByEmail,
  findProfilesForIdentity,
  resolveProfileForAudience,
  attachProfile,
  createIdentityWithProfile,
  isEmailRegistered,
  hasSuperAdminProfile,
  SuperAdminIsolationError
} = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// `accountRegistry` now only resolves a known (id, role) pair — the lookup `protect`
// performs on every request. Resolving by EMAIL moved to `identityRegistry`, because
// one email may now hold several role profiles and the answer depends on which app is
// asking. The old `findAccountByEmail` was deleted rather than adapted: returning the
// first matching collection would silently shadow every profile but one.
//
// Pure resolution logic (audience precedence, super-admin isolation) is covered
// without a database in identity-registry.test.js.

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('accountRegistry.findAccountById', () => {
  test('looks up directly in the collection for the given role', async () => {
    const { doc: driver } = await createIdentityWithProfile({
      email: `reg-byid-drv-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      role: 'driver',
      fields: { name: 'ById Driver' }
    });

    const found = await findAccountById(driver._id, 'driver');
    expect(found).not.toBeNull();
    expect(found.role).toBe('driver');

    // Same _id, wrong role -> not found (accounts don't leak across collections).
    expect(await findAccountById(driver._id, 'admin')).toBeNull();
  });
});

describe('identityRegistry — one login, several roles', () => {
  test('createIdentityWithProfile creates the login and mirrors the email onto the profile', async () => {
    const email = `identity-new-${Date.now()}@test.com`;
    const { identity, doc } = await createIdentityWithProfile({
      email,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'New Rider' }
    });

    expect(identity.email).toBe(email);
    expect(doc.email).toBe(email);
    expect(String(doc.identityId)).toBe(String(identity._id));
  });

  test('attachProfile gives an existing person a second role without touching credentials', async () => {
    const email = `identity-both-${Date.now()}@test.com`;
    const { identity } = await createIdentityWithProfile({
      email,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'Rider Who Drives' }
    });

    const { doc: driver, created } = await attachProfile({
      identityId: identity._id,
      role: 'driver',
      fields: { name: 'Rider Who Drives' }
    });

    expect(created).toBe(true);
    expect(driver.email).toBe(email);
    // The password stays on the Identity — the profile never gets its own copy.
    const driverWithPassword = await Driver.findById(driver._id).select('+password');
    expect(driverWithPassword.password).toBeUndefined();

    const roles = (await findProfilesForIdentity(identity._id)).map((p) => p.role).sort();
    expect(roles).toEqual(['driver', 'user']);
  });

  test('attachProfile is idempotent for a role the person already holds', async () => {
    const { identity } = await createIdentityWithProfile({
      email: `identity-idem-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'Idem' }
    });

    const again = await attachProfile({ identityId: identity._id, role: 'user', fields: { name: 'Idem' } });
    expect(again.created).toBe(false);
    expect(await User.countDocuments({ identityId: identity._id })).toBe(1);
  });

  test('resolveProfileForAudience returns the profile that app is for', async () => {
    const { identity } = await createIdentityWithProfile({
      email: `identity-aud-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'Multi' }
    });
    await attachProfile({ identityId: identity._id, role: 'driver', fields: { name: 'Multi' } });

    expect((await resolveProfileForAudience(identity._id, 'user')).role).toBe('user');
    expect((await resolveProfileForAudience(identity._id, 'driver')).role).toBe('driver');
    // No manager profile -> the admin portal must refuse this login.
    expect(await resolveProfileForAudience(identity._id, 'web-admin')).toBeNull();
  });

  test('one password authenticates every role the person holds', async () => {
    const email = `identity-onepw-${Date.now()}@test.com`;
    const { identity } = await createIdentityWithProfile({
      email,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'One Password' }
    });
    await attachProfile({ identityId: identity._id, role: 'driver', fields: { name: 'One Password' } });

    const stored = await Identity.findById(identity._id).select('+password');
    expect(await stored.comparePassword('P@ssw0rd!')).toBe(true);
    expect(await stored.comparePassword('wrong')).toBe(false);
  });
});

describe('identityRegistry — super-admin isolation', () => {
  test('refuses to attach any role to a super-admin login', async () => {
    const { identity } = await createIdentityWithProfile({
      email: `identity-sa-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      role: 'super-admin',
      fields: { name: 'Boss' }
    });

    expect(await hasSuperAdminProfile(identity._id)).toBe(true);
    await expect(
      attachProfile({ identityId: identity._id, role: 'user', fields: { name: 'Boss' } })
    ).rejects.toThrow(SuperAdminIsolationError);
  });

  test('refuses to make an existing rider a super-admin', async () => {
    const { identity } = await createIdentityWithProfile({
      email: `identity-rider-sa-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'Just A Rider' }
    });

    await expect(
      attachProfile({ identityId: identity._id, role: 'super-admin', fields: { name: 'Just A Rider' } })
    ).rejects.toThrow(SuperAdminIsolationError);
  });
});

describe('identityRegistry.isEmailRegistered', () => {
  test('asks whether any Identity owns the email', async () => {
    const email = `identity-owned-${Date.now()}@test.com`;
    expect(await isEmailRegistered(email)).toBe(false);

    const { identity } = await createIdentityWithProfile({
      email,
      password: 'P@ssw0rd!',
      role: 'admin',
      fields: { name: 'Owner' }
    });

    expect(await isEmailRegistered(email)).toBe(true);
    // excludeIdentityId lets that identity's own update pass without a false positive.
    expect(await isEmailRegistered(email, { excludeIdentityId: identity._id })).toBe(false);
  });

  test('findIdentityByEmail normalises case and whitespace', async () => {
    const email = `identity-norm-${Date.now()}@test.com`;
    await createIdentityWithProfile({
      email,
      password: 'P@ssw0rd!',
      role: 'user',
      fields: { name: 'Norm' }
    });

    expect(await findIdentityByEmail(`  ${email.toUpperCase()}  `)).not.toBeNull();
    expect(await findIdentityByEmail('')).toBeNull();
  });
});

describe('identityRegistry — a manager keeps their own password', () => {
  test('attaching a manager role does not create or change a credential', async () => {
    // This is the regression guard for the provisioning hole: a manager/super-admin
    // must never be able to set the password on an email that is already somebody's.
    const email = `identity-keep-pw-${Date.now()}@test.com`;
    const { identity } = await createIdentityWithProfile({
      email,
      password: 'RidersOwn1!',
      role: 'user',
      fields: { name: 'Rider Turned Manager' }
    });

    await attachProfile({ identityId: identity._id, role: 'admin', fields: { name: 'Rider Turned Manager' } });

    const stored = await Identity.findById(identity._id).select('+password');
    expect(await stored.comparePassword('RidersOwn1!')).toBe(true);

    const manager = await Manager.findOne({ identityId: identity._id }).select('+password');
    expect(manager.password).toBeUndefined();
  });
});
