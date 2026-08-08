const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Manager = require('../../src/models/Manager');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// GET /api/auth/me. A driver's name and phone number are maintained by their
// manager, so the copy a client stored at sign-in goes stale with nothing to
// announce it. This is how a client re-reads itself.

const stamp = Date.now();
let driverToken;
let driver;

const login = (identifier, password) =>
  request(app).post('/api/auth/login').send({ identifier, password });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const manager = await Manager.create({
    name: 'Me Manager',
    email: `mgr-me-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });

  driver = await Driver.create({
    name: 'Me Driver',
    email: `drv-me-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    managerId: manager._id,
    phoneNumber: '0766518388',
    isActive: true,
    isEmailVerified: true
  });

  driverToken = (await login(driver.email, 'P@ssw0rd!')).body.accessToken;
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
});
