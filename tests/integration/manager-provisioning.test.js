const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Identity = require('../../src/models/Identity');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin, authHeader, login: loginAs } = require('./factories');

// Manager provisioning: the super admin creates the account with an email and a
// password directly. There is no invite email, no activation link and no pending
// state — the manager can log in the moment the account exists.

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

const GOOD_PASSWORD = 'MgrPass1!';

const createManager = (email, password = GOOD_PASSWORD) =>
  request(app)
    .post('/api/super-admin/managers')
    .set(...auth())
    .send({ name: 'Direct Mgr', email, password, serviceType: 'PUBLIC' });

describe('Manager creation with a directly-set password', () => {
  it('creates an immediately-active manager and never returns an activation link', async () => {
    const res = await createManager(`dir1-${Date.now()}@t.com`);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.activatedAt).toBeTruthy();
    expect(res.body.data.invitedAt).toBeNull();
    // The invite flow is gone — nothing link- or email-shaped may come back.
    expect(res.body.activationLink).toBeUndefined();
    expect(res.body.emailSent).toBeUndefined();
  });

  it('lets the manager log in with the password the super admin set', async () => {
    const email = `dir2-${Date.now()}@t.com`;
    await createManager(email);

    const login = await loginAs(email, GOOD_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
  });

  it('never stores the password in plaintext', async () => {
    const email = `dir3-${Date.now()}@t.com`;
    await createManager(email);

    // The credential lives on Identity, not the Manager profile — `password` on
    // an identity-linked profile is a dormant field (see shared/accountFields.js).
    const stored = await Identity.findOne({ email: email.toLowerCase() }).select('+password');
    expect(stored.password).not.toBe(GOOD_PASSWORD);
    expect(stored.password).toMatch(/^\$2[aby]\$/); // bcrypt hash
  });

  it('rejects the wrong password', async () => {
    const email = `dir4-${Date.now()}@t.com`;
    await createManager(email);

    expect((await loginAs(email, 'NotThePassword1!')).status).toBe(401);
  });

  it('requires a password', async () => {
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({ name: 'No Password Mgr', email: `dir5-${Date.now()}@t.com`, serviceType: 'PUBLIC' });

    expect(res.status).toBe(400);
  });

  it.each([
    ['too short', 'Ab1!'],
    ['no uppercase', 'lowerpass1!'],
    ['no lowercase', 'UPPERPASS1!'],
    ['no number', 'NoNumber!!'],
    ['no special character', 'NoSpecial11'],
  ])('rejects a weak password (%s)', async (_label, password) => {
    const email = `weak-${Date.now()}-${_label.replace(/\s/g, '')}@t.com`;
    const res = await createManager(email, password);

    expect(res.status).toBe(400);
    expect(await Manager.findOne({ email: email.toLowerCase() })).toBeNull();
  });

  it('rejects a duplicate email', async () => {
    const email = `dup-${Date.now()}@t.com`;
    expect((await createManager(email)).status).toBe(201);
    expect((await createManager(email)).status).toBe(409);
  });
});

describe('Super-admin password reset (direct)', () => {
  it('sets a new password so the old one stops working', async () => {
    const email = `rst-${Date.now()}@t.com`;
    const created = await createManager(email);
    const managerId = created.body.data._id;

    const reset = await request(app)
      .patch(`/api/super-admin/managers/${managerId}/reset-password`)
      .set(...auth())
      .send({ password: 'ChangedPass2!' });

    expect(reset.status).toBe(200);
    // No link may be handed back — the super admin shares the password directly.
    expect(reset.body.resetLink).toBeUndefined();

    expect((await loginAs(email, GOOD_PASSWORD)).status).toBe(401);
    expect((await loginAs(email, 'ChangedPass2!')).status).toBe(200);
  });

  it('rejects a weak replacement password and keeps the old one working', async () => {
    const email = `rst2-${Date.now()}@t.com`;
    const created = await createManager(email);

    const reset = await request(app)
      .patch(`/api/super-admin/managers/${created.body.data._id}/reset-password`)
      .set(...auth())
      .send({ password: 'weak' });

    expect(reset.status).toBe(400);
    expect((await loginAs(email, GOOD_PASSWORD)).status).toBe(200);
  });

  it('404s for a manager that does not exist', async () => {
    const res = await request(app)
      .patch('/api/super-admin/managers/6a63e3fa67212cbddf637779/reset-password')
      .set(...auth())
      .send({ password: 'ChangedPass2!' });

    expect(res.status).toBe(404);
  });
});
