const request = require('supertest');
const app = require('../../src/server');
const { ensureDriverEnrollmentKey, rotateDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createDriver, createRider } = require('./factories');

// GET /api/driver/enrollment-key — a driver reading their own key, so they can
// pass it to a passenger without the manager relaying it out of band. The id
// comes from the token, so there is no other driver's key to ask for.

let driver;
let driverToken;
let otherDriverToken;
let passengerToken;

const get = (token) => {
  const req = request(app).get('/api/driver/enrollment-key');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  // Only referenced as a managerId foreign key below, so it never signs in.
  const manager = await createManager({ name: 'Key Manager', signIn: false });

  const keyDriver = await createDriver({
    name: 'Key Driver',
    fields: { managerId: manager.id, isPrivate: true }
  });
  driver = keyDriver.doc;
  driverToken = keyDriver.token;

  ({ token: otherDriverToken } = await createDriver({
    name: 'Other Key Driver',
    fields: { managerId: manager.id }
  }));

  ({ token: passengerToken } = await createRider({ name: 'Key Passenger' }));
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
