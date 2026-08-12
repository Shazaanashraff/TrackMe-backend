const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { attachProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin, createManager, authHeader } = require('./factories');

// superAdminController.updateManager refuses to change a manager's email once
// their identity holds more than one role profile — changing the email would
// silently rename the person's whole login. That guard reads
// findProfilesForIdentity(manager.identityId).length, and after multi-rider-
// profiles, a manager who is also a parent could in principle hold several
// User documents under one identity (their own rider profile plus the
// children they manage). This locks that managed profiles never inflate (or
// deflate) that count — findProfilesForIdentity is scoped to the account
// holder's own rider profile only, so it stays exactly as it was before this
// feature existed.

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  ({ token: superAdminToken } = await createSuperAdmin({ name: 'Super Admin' }));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => authHeader(superAdminToken);

const updateEmail = (managerId, email) =>
  request(app)
    .put(`/api/super-admin/managers/${managerId}`)
    .set(...auth())
    .send({ email });

describe('updateManager email guard vs. managed rider profiles', () => {
  it('allows the email change while the identity holds only the manager role', async () => {
    const manager = await createManager({ name: 'Solo Manager', signIn: false });

    const res = await updateEmail(manager.id, `changed-${Date.now()}@t.com`);
    expect(res.status).toBe(200);
  });

  it('blocks the email change once the identity also holds a rider role', async () => {
    const manager = await createManager({ name: 'Dual Role Manager', signIn: false });
    await attachProfile({ identityId: manager.identity._id, role: 'user', fields: { name: 'Dual Role Manager' } });

    const res = await updateEmail(manager.id, `changed-${Date.now()}@t.com`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTITY_SHARED_EMAIL_IMMUTABLE');
  });

  it('stays blocked for the same reason after adding managed rider profiles — the count does not change', async () => {
    const manager = await createManager({ name: 'Parent Manager', signIn: false });
    const { doc: riderProfile } = await attachProfile({
      identityId: manager.identity._id, role: 'user', fields: { name: 'Parent Manager' }
    });

    // Two children under the same identity as the rider profile just attached.
    await User.create({ name: 'Child A', identityId: riderProfile.identityId, profileKind: 'MANAGED' });
    await User.create({ name: 'Child B', identityId: riderProfile.identityId, profileKind: 'MANAGED' });

    const res = await updateEmail(manager.id, `changed-${Date.now()}@t.com`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTITY_SHARED_EMAIL_IMMUTABLE');
  });
});
