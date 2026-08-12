const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const SuperAdmin = require('../../src/models/SuperAdmin');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Issue #36: a super-admin/manager deactivated mid-session must not keep API
// access for the remaining lifetime of their already-issued access token.
// `protect` (src/middleware/auth.js) re-fetches the account from its collection
// on every request and rejects when isActive is false, so a still-unexpired JWT
// is already denied the moment the account is deactivated — this locks that
// behavior in with a regression test.

const stamp = Date.now();

const login = (identifier, password) =>
  request(app).post('/api/auth/login').send({ identifier, password });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('deactivation revokes an in-flight JWT before it naturally expires', () => {
  it('rejects a manager\'s existing token the moment they are deactivated', async () => {
    const manager = await Manager.create({
      name: 'Session Revocation Manager',
      email: `mgr-revoke-${stamp}@t.com`,
      password: 'P@ssw0rd!',
      isEmailVerified: true,
      isActive: true
    });

    const token = (await login(manager.email, 'P@ssw0rd!')).body.accessToken;
    expect(token).toBeTruthy();

    const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    manager.isActive = false;
    await manager.save();

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
  });

  it('rejects a super-admin\'s existing token the moment they are deactivated', async () => {
    const superAdmin = await SuperAdmin.create({
      name: 'Session Revocation Admin',
      email: `sa-revoke-${stamp}@t.com`,
      password: 'P@ssw0rd!',
      isEmailVerified: true,
      isActive: true
    });

    const token = (await login(superAdmin.email, 'P@ssw0rd!')).body.accessToken;
    expect(token).toBeTruthy();

    const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    superAdmin.isActive = false;
    await superAdmin.save();

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(403);
  });
});
