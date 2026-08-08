const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Manager = require('../../src/models/Manager');
const User = require('../../src/models/User');
const {
  ensureDriverEnrollmentKey,
  rotateDriverEnrollmentKey
} = require('../../src/utils/enrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// GET /api/driver/enrollment-key — a driver reading their own key, so they can
// pass it to a passenger without the manager relaying it out of band. The id
// comes from the token, so there is no other driver's key to ask for.

const stamp = Date.now();
let driver;
let driverToken;
let otherDriverToken;
let passengerToken;

const login = (identifier, password) =>
  request(app).post('/api/auth/login').send({ identifier, password });

const get = (token) => {
  const req = request(app).get('/api/driver/enrollment-key');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const manager = await Manager.create({
    name: 'Key Manager',
    email: `mgr-key-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });

  driver = await Driver.create({
    name: 'Key Driver',
    email: `drv-key-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    managerId: manager._id,
    isPrivate: true,
    isActive: true,
    isEmailVerified: true
  });
  driverToken = (await login(driver.email, 'P@ssw0rd!')).body.accessToken;

  const otherDriver = await Driver.create({
    name: 'Other Key Driver',
    email: `drv-key2-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    managerId: manager._id,
    isActive: true,
    isEmailVerified: true
  });
  otherDriverToken = (await login(otherDriver.email, 'P@ssw0rd!')).body.accessToken;

  const passenger = await User.create({
    name: 'Key Passenger',
    email: `usr-key-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    role: 'user',
    isEmailVerified: true,
    isActive: true
  });
  passengerToken = (await login(passenger.email, 'P@ssw0rd!')).body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/driver/enrollment-key', () => {
  it('returns the key the manager would reveal, and the approval state with it', async () => {
    const managerView = await ensureDriverEnrollmentKey(driver._id);

    const res = await get(driverToken);

    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentKey).toBe(managerView);
    expect(res.body.data.isPrivate).toBe(true);
  });

  it('follows a rotation rather than returning the voided key', async () => {
    // A replaced key stops working the moment the manager rotates it, so a
    // driver still reading the old one hands out a code that fails.
    const rotated = await rotateDriverEnrollmentKey(driver._id);

    const res = await get(driverToken);

    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentKey).toBe(rotated);
  });

  it('gives each driver their own key and no way to name another', async () => {
    const mine = (await get(driverToken)).body.data.enrollmentKey;
    const theirs = (await get(otherDriverToken)).body.data.enrollmentKey;

    expect(theirs).toBeTruthy();
    expect(theirs).not.toBe(mine);
  });

  it('issues a key on first read for a driver who has never had one', async () => {
    const res = await get(otherDriverToken);
    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentKey).toMatch(/^TMD-/);
  });

  it('is closed to passengers and to anonymous callers', async () => {
    expect((await get(passengerToken)).status).toBe(403);
    expect((await get(null)).status).toBe(401);
  });
});
