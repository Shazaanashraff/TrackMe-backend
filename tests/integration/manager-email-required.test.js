// When real email IS configured, invite/reset must go by email only — no on-screen
// demo-link fallback. We simulate "email configured but the send failed" by mocking
// the accountSetup util (isEmailConfigured → true, send → false) and assert the
// endpoints hard-fail (502) without leaking a link, and that a failed invite rolls
// back the created manager.
jest.mock('../../src/utils/accountSetup', () => {
  const actual = jest.requireActual('../../src/utils/accountSetup');
  return {
    ...actual,
    isEmailConfigured: () => true,
    sendAccountSetupEmail: jest.fn().mockResolvedValue(false)
  };
});

const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  const superAdmin = await User.create({
    name: 'Super Admin', email: `sa-email-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'super-admin', isEmailVerified: true, isActive: true
  });
  superAdminToken = await loginAs(superAdmin.email, 'P@ssw0rd!');
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${superAdminToken}`];

describe('Email required (no demo fallback)', () => {
  it('502s and does not create the manager when the invite email fails to send', async () => {
    const email = `emailfail-${Date.now()}@t.com`;
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({ name: 'No Email Mgr', email, serviceType: 'PUBLIC' });

    expect(res.status).toBe(502);
    expect(res.body.activationLink).toBeUndefined();
    // Rolled back — the manager was not persisted.
    const exists = await User.findOne({ email: email.toLowerCase() });
    expect(exists).toBeNull();
  });

  it('502s on reset when the email fails, and never returns a resetLink', async () => {
    const manager = await User.create({
      name: 'Active Mgr', email: `rstfail-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      role: 'admin', isEmailVerified: true, isActive: true, activatedAt: new Date()
    });

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager._id}/reset-password`)
      .set(...auth());

    expect(res.status).toBe(502);
    expect(res.body.resetLink).toBeUndefined();
  });
});
