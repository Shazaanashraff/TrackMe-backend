const request = require('supertest');
const app = require('../../src/server');
const SuperAdmin = require('../../src/models/SuperAdmin');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Manager provisioning: the super admin invites managers (no password); each
// manager sets their own password via a one-time emailed link. When email isn't
// configured the link is returned in the response (dev fallback) so we can drive
// the whole activation + reset lifecycle here.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res;
}

const tokenFromLink = (link) => new URL(link).searchParams.get('token');

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  // Force the "no email service" path so activation/reset links come back in the
  // response body regardless of local .env.
  delete process.env.RESEND_API_KEY;
  process.env.NODE_ENV = 'test';

  const superAdmin = await SuperAdmin.create({
    name: 'Super Admin', email: `sa-prov-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const res = await loginAs(superAdmin.email, 'P@ssw0rd!');
  superAdminToken = res.body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${superAdminToken}`];

const createManager = (email) =>
  request(app)
    .post('/api/super-admin/managers')
    .set(...auth())
    .send({ name: 'Invited Mgr', email, serviceType: 'PUBLIC' });

describe('Manager invite → activate lifecycle', () => {
  it('creates an INVITED manager without a password and returns an activation link', async () => {
    const res = await createManager(`inv1-${Date.now()}@t.com`);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('INVITED');
    expect(res.body.data.invitedAt).toBeTruthy();
    expect(res.body.data.activatedAt).toBeNull();
    expect(res.body.emailSent).toBe(false);
    expect(res.body.activationLink).toContain('/activate?token=');
  });

  it('validates the link (purpose INVITE), sets a password, then the manager can log in', async () => {
    const email = `inv2-${Date.now()}@t.com`;
    const created = await createManager(email);
    const token = tokenFromLink(created.body.activationLink);

    // Validate reveals whose account it is and that it's a first-time invite.
    const validate = await request(app).post('/api/auth/account-setup/validate').send({ token });
    expect(validate.status).toBe(200);
    expect(validate.body.email).toBe(email.toLowerCase());
    expect(validate.body.purpose).toBe('INVITE');

    // Cannot log in before activating (password is a random unknown value).
    const preLogin = await loginAs(email, 'NotThePassword1');
    expect(preLogin.status).toBe(401);

    // Set own password.
    const complete = await request(app)
      .post('/api/auth/account-setup/complete')
      .send({ token, password: 'MyNewPass1' });
    expect(complete.status).toBe(200);

    // Now login works, and the roster shows ACTIVE.
    const login = await loginAs(email, 'MyNewPass1');
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');

    const list = await request(app).get('/api/super-admin/managers').set(...auth());
    const row = list.body.data.find((m) => m.email === email.toLowerCase());
    expect(row.status).toBe('ACTIVE');
    expect(row.activatedAt).toBeTruthy();
  });

  it('rejects a used or invalid token', async () => {
    const email = `inv3-${Date.now()}@t.com`;
    const created = await createManager(email);
    const token = tokenFromLink(created.body.activationLink);
    await request(app).post('/api/auth/account-setup/complete').send({ token, password: 'FirstPass1' });

    // Token is single-use — a second complete fails.
    const reuse = await request(app).post('/api/auth/account-setup/complete').send({ token, password: 'SecondPass1' });
    expect(reuse.status).toBe(400);

    // Garbage token fails validation lookup.
    const bad = await request(app).post('/api/auth/account-setup/validate').send({ token: 'not-a-real-token' });
    expect(bad.status).toBe(400);
  });

  it('rejects a too-short password', async () => {
    const created = await createManager(`inv4-${Date.now()}@t.com`);
    const token = tokenFromLink(created.body.activationLink);
    const res = await request(app).post('/api/auth/account-setup/complete').send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('Super-admin password reset (link)', () => {
  it('issues a RESET link for an active manager; old password stops working after reset', async () => {
    const email = `rst-${Date.now()}@t.com`;
    const created = await createManager(email);
    await request(app)
      .post('/api/auth/account-setup/complete')
      .send({ token: tokenFromLink(created.body.activationLink), password: 'OriginalPass1' });
    const managerId = created.body.data._id;

    // Super admin triggers a reset — gets a link (no plaintext password involved).
    const reset = await request(app)
      .patch(`/api/super-admin/managers/${managerId}/reset-password`)
      .set(...auth());
    expect(reset.status).toBe(200);
    expect(reset.body.resetLink).toContain('/activate?token=');

    const resetToken = tokenFromLink(reset.body.resetLink);
    const validate = await request(app).post('/api/auth/account-setup/validate').send({ token: resetToken });
    expect(validate.body.purpose).toBe('RESET');

    await request(app).post('/api/auth/account-setup/complete').send({ token: resetToken, password: 'ChangedPass2' });

    expect((await loginAs(email, 'OriginalPass1')).status).toBe(401);
    expect((await loginAs(email, 'ChangedPass2')).status).toBe(200);
  });
});
