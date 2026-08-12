const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, authHeader } = require('./factories');

// qr-attendance.test.js covers self-read and the manager fleet-ownership
// path. This covers what changes under multiple rider profiles: reading a
// household member's attendance, and the null-equality regression that
// requireOwnProfile (middleware/auth.js) already guards against — this is
// the same discipline applied to a second authz site.

let primary;
let primaryAuth;
let child;

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  primary = await createRider({ name: 'Parent' });
  primaryAuth = authHeader(primary.token);
  child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });

  await BoardingEvent.create({
    studentId: child._id, vehicleId: 'V-1', routeId: 'R-1', driverId: primary.id, type: 'BOARD', tripId: 'T-1'
  });
});

describe("GET /api/attendance/student/:studentId — household access", () => {
  it("the account holder reads a managed child's attendance", async () => {
    const res = await request(app)
      .get(`/api/attendance/student/${child._id}`)
      .set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(1);
  });

  it("a managed profile, once switched in, reads the account holder's own attendance", async () => {
    await BoardingEvent.create({
      studentId: primary.id, vehicleId: 'V-2', routeId: 'R-2', driverId: primary.id, type: 'BOARD', tripId: 'T-2'
    });
    const switchRes = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
    const childAuth = authHeader(switchRes.body.accessToken);

    const res = await request(app)
      .get(`/api/attendance/student/${primary.id}`)
      .set(...childAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(1);
  });

  it("403s a rider with no relation to the target and no managing role", async () => {
    const stranger = await createRider({ name: 'Stranger' });

    const res = await request(app)
      .get(`/api/attendance/student/${child._id}`)
      .set(...authHeader(stranger.token));

    expect(res.status).toBe(403);
  });

  // The regression this authz site now guards against, mirroring
  // requireOwnProfile's own test: two accounts that each predate the
  // identityId field must never read as the same household just because
  // `undefined === undefined`.
  it('never grants access between two accounts that both lack an identityId', async () => {
    const orphanCaller = await User.create({ name: 'Orphan Caller', profileKind: 'PRIMARY', email: 'orphan-caller-attn@t.com' });
    const orphanTarget = await User.create({ name: 'Orphan Target', profileKind: 'PRIMARY', email: 'orphan-target-attn@t.com' });
    expect(orphanCaller.identityId).toBeUndefined();
    expect(orphanTarget.identityId).toBeUndefined();

    const jwt = require('jsonwebtoken');
    const forgedToken = jwt.sign({ id: orphanCaller._id, role: 'user', tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '15m' });

    const res = await request(app)
      .get(`/api/attendance/student/${orphanTarget._id}`)
      .set('Authorization', `Bearer ${forgedToken}`);

    expect(res.status).toBe(403);
  });
});
