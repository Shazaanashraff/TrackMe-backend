const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createDriver } = require('./factories');

// GET /api/auth/me. A driver's name and phone number are maintained by their
// manager, so the copy a client stored at sign-in goes stale with nothing to
// announce it. This is how a client re-reads itself.

let driverToken;
let driver;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  // Only referenced as a managerId foreign key below, so it never signs in.
  const manager = await createManager({ name: 'Me Manager', signIn: false });

  ({ doc: driver, token: driverToken } = await createDriver({
    name: 'Me Driver',
    fields: { managerId: manager.id, phoneNumber: '0766518388' }
  }));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in account, phone number included', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Me Driver');
    expect(res.body.user.phoneNumber).toBe('0766518388');
    expect(res.body.user.role).toBe('driver');
  });

  it('reflects a change the manager made after the token was issued', async () => {
    // The whole point of the endpoint: the same token, a newer answer.
    await Driver.findByIdAndUpdate(driver._id, { phoneNumber: '0771234567' });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.phoneNumber).toBe('0771234567');
  });

  it('never returns the password', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.body.user.password).toBeUndefined();
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different algorithm than the pinned allowlist', async () => {
    const forged = jwt.sign(
      { id: driver._id, role: 'driver' },
      process.env.JWT_SECRET,
      { algorithm: 'HS384' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const forged = jwt.sign(
      { id: driver._id, role: 'driver' },
      null,
      { algorithm: 'none' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });
});
