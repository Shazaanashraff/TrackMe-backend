const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, authHeader } = require('./factories');

// /api/profiles — see docs/modules/PROFILES.md. Covers the full CRUD +
// switch surface plus the authz failure cases the repo's testing rule
// requires alongside any behaviour change.

let primary;
let primaryAuth;

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
});

describe('GET /api/profiles', () => {
  it('lists just the primary for a fresh account, with the account block populated', async () => {
    const res = await request(app).get('/api/profiles').set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Parent', profileKind: 'PRIMARY', isActive: true });
    expect(res.body.account).toMatchObject({ email: primary.email });
  });

  it('lists every household member, primary first', async () => {
    await User.create({ name: 'Child A', identityId: primary.identity._id, profileKind: 'MANAGED' });
    await User.create({ name: 'Child B', identityId: primary.identity._id, profileKind: 'MANAGED' });

    const res = await request(app).get('/api/profiles').set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.name)).toEqual(['Parent', 'Child A', 'Child B']);
    expect(res.body.data.filter((p) => p.profileKind === 'MANAGED')).toHaveLength(2);
  });
});

describe('POST /api/profiles', () => {
  it('the account holder creates a managed profile', async () => {
    const res = await request(app)
      .post('/api/profiles')
      .set(...primaryAuth)
      .send({ name: 'New Child', relation: 'Daughter' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'New Child', relation: 'Daughter', profileKind: 'MANAGED' });

    const stored = await User.findById(res.body.data._id);
    expect(String(stored.identityId)).toBe(String(primary.identity._id));
    expect(stored.email).toBeUndefined();
  });

  it('accepts an optional phone number, validated the same way as everywhere else', async () => {
    const good = await request(app).post('/api/profiles').set(...primaryAuth)
      .send({ name: 'Employee One', phoneNumber: '0771234567' });
    expect(good.status).toBe(201);

    const bad = await request(app).post('/api/profiles').set(...primaryAuth)
      .send({ name: 'Employee Two', phoneNumber: '12345' });
    expect(bad.status).toBe(400);
  });

  it('rejects a missing name', async () => {
    const res = await request(app).post('/api/profiles').set(...primaryAuth).send({});
    expect(res.status).toBe(400);
  });

  it('403s a managed profile trying to create a sibling (MANAGED_PROFILE_FORBIDDEN)', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    const switchRes = await request(app)
      .post(`/api/profiles/${child._id}/switch`)
      .set(...primaryAuth);
    const childAuth = authHeader(switchRes.body.accessToken);

    const res = await request(app).post('/api/profiles').set(...childAuth).send({ name: 'Sibling' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MANAGED_PROFILE_FORBIDDEN');
  });

  it('409s once the household is at the profile cap', async () => {
    const creates = Array.from({ length: 19 }, (_, i) =>
      request(app).post('/api/profiles').set(...primaryAuth).send({ name: `Kid ${i}` }));
    await Promise.all(creates); // 1 primary + 19 managed = 20, the cap

    const res = await request(app).post('/api/profiles').set(...primaryAuth).send({ name: 'One Too Many' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOUSEHOLD_LIMIT');
  });
});

describe('PATCH /api/profiles/:id', () => {
  it('the account holder renames a managed profile', async () => {
    const child = await User.create({ name: 'Old Name', identityId: primary.identity._id, profileKind: 'MANAGED' });

    const res = await request(app)
      .patch(`/api/profiles/${child._id}`)
      .set(...primaryAuth)
      .send({ name: 'New Name', relation: 'Son' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'New Name', relation: 'Son' });
  });

  it('a managed profile edits itself once switched in', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    const switchRes = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
    const childAuth = authHeader(switchRes.body.accessToken);

    const res = await request(app)
      .patch(`/api/profiles/${child._id}`)
      .set(...childAuth)
      .send({ name: 'Renamed By Self' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed By Self');
  });

  it('404s a rename attempt on a profile belonging to a different identity', async () => {
    const other = await createRider({ name: 'Stranger' });

    const res = await request(app)
      .patch(`/api/profiles/${other.id}`)
      .set(...primaryAuth)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/profiles/:id/avatar', () => {
  it('returns the target profile\'s own avatar', async () => {
    const child = await User.create({
      name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED', avatarUrl: 'data:image/png;base64,abc'
    });

    const res = await request(app).get(`/api/profiles/${child._id}/avatar`).set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBe('data:image/png;base64,abc');
  });

  it('404s for another identity\'s profile', async () => {
    const other = await createRider({ name: 'Stranger' });

    const res = await request(app).get(`/api/profiles/${other.id}/avatar`).set(...primaryAuth);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/profiles/:id', () => {
  it('soft-deletes a managed profile and cascades DriverEnrollment but keeps BoardingEvent history', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    await DriverEnrollment.create({
      userId: child._id, driverId: primary.id, status: 'ACTIVE'
    });
    await BoardingEvent.create({
      studentId: child._id, vehicleId: 'V-1', routeId: 'R-1', driverId: primary.id, type: 'BOARD', tripId: 'T-1'
    });

    const res = await request(app).delete(`/api/profiles/${child._id}`).set(...primaryAuth);
    expect(res.status).toBe(200);

    const stored = await User.findById(child._id);
    expect(stored.isActive).toBe(false);
    expect(stored.deletedAt).toBeTruthy();

    expect(await DriverEnrollment.countDocuments({ userId: child._id })).toBe(0);
    expect(await BoardingEvent.countDocuments({ studentId: child._id })).toBe(1);
  });

  it('refuses to delete the primary profile', async () => {
    const res = await request(app).delete(`/api/profiles/${primary.id}`).set(...primaryAuth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANNOT_DELETE_PRIMARY');
  });

  it('403s a managed profile trying to delete anyone, including itself', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    const switchRes = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
    const childAuth = authHeader(switchRes.body.accessToken);

    const res = await request(app).delete(`/api/profiles/${child._id}`).set(...childAuth);
    expect(res.status).toBe(403);
  });

  it('404s deleting another identity\'s profile', async () => {
    const other = await createRider({ name: 'Stranger' });
    const res = await request(app).delete(`/api/profiles/${other.id}`).set(...primaryAuth);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/profiles/:id/switch', () => {
  it('issues a token pair that resolves to the target profile', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });

    const switchRes = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
    expect(switchRes.status).toBe(200);
    expect(switchRes.body.user.profileKind).toBe('MANAGED');
    expect(switchRes.body.user.email).toBe(primary.email); // account email, not blank

    const me = await request(app).get('/api/auth/me').set(...authHeader(switchRes.body.accessToken));
    expect(me.status).toBe(200);
    expect(String(me.body.user._id)).toBe(String(child._id));
  });

  it("switching does not invalidate the source profile's own session", async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);

    const stillWorks = await request(app).get('/api/auth/me').set(...primaryAuth);
    expect(stillWorks.status).toBe(200);
  });

  it('403s switching to a deactivated profile', async () => {
    const child = await User.create({
      name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED', isActive: false
    });

    const res = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
    expect(res.status).toBe(403);
  });

  it("404s switching to another identity's profile — the account-hijack case", async () => {
    const other = await createRider({ name: 'Stranger' });

    const res = await request(app).post(`/api/profiles/${other.id}/switch`).set(...primaryAuth);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/profiles/household/enrollments', () => {
  it('groups each profile with its own enrollments', async () => {
    const child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
    await DriverEnrollment.create({ userId: primary.id, driverId: primary.id, status: 'ACTIVE' });
    await DriverEnrollment.create({ userId: child._id, driverId: primary.id, status: 'PENDING' });

    const res = await request(app).get('/api/profiles/household/enrollments').set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const primaryRow = res.body.data.find((row) => row.profile.profileKind === 'PRIMARY');
    const childRow = res.body.data.find((row) => row.profile.profileKind === 'MANAGED');
    expect(primaryRow.enrollments).toHaveLength(1);
    expect(primaryRow.enrollments[0].status).toBe('ACTIVE');
    expect(childRow.enrollments).toHaveLength(1);
    expect(childRow.enrollments[0].status).toBe('PENDING');
  });

  it('returns an empty list, not everyone, for an identity with no household', async () => {
    const res = await request(app).get('/api/profiles/household/enrollments').set(...primaryAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.every((row) => row.enrollments.length === 0)).toBe(true);
  });
});
