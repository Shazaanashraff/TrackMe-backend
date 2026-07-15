const request = require('supertest');
const app = require('../../src/server');
const jwt = require('jsonwebtoken');
const User = require('../../src/models/User');
const Route = require('../../src/models/Route');
const Bus = require('../../src/models/Bus');
const RouteMembership = require('../../src/models/RouteMembership');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { signQr, verifyQr } = require('../../src/utils/qrToken');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// QR Attendance foundation — see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md
// and todos/complete/001-qr-attendance-foundation.md. Covers token sign/verify,
// issue/rotate, the driver scan endpoint (toggle + debounce), attendance reads,
// and device-token registration. Push delivery is mocked (no real Expo calls).

jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
  function Expo() {
    return { chunkPushNotifications: (messages) => [messages], sendPushNotificationsAsync };
  }
  Expo.isExpoPushToken = (t) => typeof t === 'string' && t.startsWith('ExponentPushToken');
  return { Expo, __mockSendPushNotificationsAsync: sendPushNotificationsAsync };
});

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

let managerToken, managerId;
let otherManagerToken, otherManagerId;
let riderToken, riderId;
let driverToken, driverId;
let otherDriverToken, otherDriverId;
let route, bus;
let membership;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await User.create({
    name: 'QR Manager', email: `qr-mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  managerId = manager._id;
  managerToken = await loginAs(manager.email, 'P@ssw0rd!');

  const otherManager = await User.create({
    name: 'QR Other Manager', email: `qr-mgr2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  otherManagerId = otherManager._id;
  otherManagerToken = await loginAs(otherManager.email, 'P@ssw0rd!');

  const rider = await User.create({
    name: 'QR Rider', email: `qr-rider-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true,
    pushTokens: ['ExponentPushToken[abc123]']
  });
  riderId = rider._id;
  riderToken = await loginAs(rider.email, 'P@ssw0rd!');

  const driver = await User.create({
    name: 'QR Driver', email: `qr-drv-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'driver', isEmailVerified: true, isActive: true
  });
  driverId = driver._id;
  driverToken = await loginAs(driver.email, 'P@ssw0rd!');

  const otherDriver = await User.create({
    name: 'QR Other Driver', email: `qr-drv2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'driver', isEmailVerified: true, isActive: true
  });
  otherDriverId = otherDriver._id;
  otherDriverToken = await loginAs(otherDriver.email, 'P@ssw0rd!');

  route = await Route.create({
    routeId: `QR-${Date.now()}`.toUpperCase(),
    routeName: 'QR Attendance Route',
    source: 'Home', destination: 'Work', distance: 10, fare: 100,
    managerId, stops: [{ stopName: 'Stop A', order: 1, lat: 1, lng: 1 }], pathPolyline: 'abc'
  });

  bus = await Bus.create({
    busId: `QR-BUS-${Date.now()}`,
    busName: 'QR Shuttle',
    registrationNumber: `REG-${Date.now()}`,
    numberPlate: `PLT-${Date.now()}`,
    routeId: route.routeId,
    driverId,
    seatCapacity: 40,
    managerId
  });

  membership = await RouteMembership.create({
    userId: riderId, routeId: route.routeId, managerId, status: 'ACTIVE', grantedVia: 'APPROVAL'
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

afterEach(async () => {
  await BoardingEvent.deleteMany({});
});

describe('qrToken utils', () => {
  it('signQr produces a token that verifyQr resolves as valid', async () => {
    const fresh = await RouteMembership.findById(membership._id);
    const { token, payload } = signQr(fresh);
    expect(payload.sub).toBe(String(fresh._id));
    expect(payload.ver).toBe(fresh.tokenVersion);

    const result = await verifyQr(token);
    expect(result.valid).toBe(true);
    expect(String(result.membership._id)).toBe(String(fresh._id));
  });

  it('rejects a garbage/tampered token', async () => {
    const result = await verifyQr('not-a-real-token');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID');
  });

  it('rejects an expired token', async () => {
    const fresh = await RouteMembership.findById(membership._id);
    const expired = jwt.sign(
      { sub: String(fresh._id), stu: String(fresh.userId), rt: fresh.routeId, ver: fresh.tokenVersion, jti: 'x' },
      process.env.QR_JWT_SECRET,
      { expiresIn: -10 }
    );
    const result = await verifyQr(expired);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('EXPIRED');
  });

  it('rejects a token whose tokenVersion is stale after a rotate', async () => {
    const m = await RouteMembership.create({
      userId: riderId, routeId: route.routeId, managerId, status: 'ACTIVE', grantedVia: 'APPROVAL'
    });
    const { token } = signQr(m);
    m.tokenVersion += 1;
    await m.save();

    const result = await verifyQr(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('STALE_VERSION');

    await RouteMembership.deleteOne({ _id: m._id });
  });

  it('rejects a token for a membership that no longer exists', async () => {
    const m = await RouteMembership.create({
      userId: riderId, routeId: route.routeId, managerId, status: 'ACTIVE', grantedVia: 'APPROVAL'
    });
    const { token } = signQr(m);
    await RouteMembership.deleteOne({ _id: m._id });

    const result = await verifyQr(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('MEMBERSHIP_NOT_FOUND');
  });
});

describe('POST /api/qr/issue', () => {
  it('issues a token for the caller\'s active membership', async () => {
    const res = await request(app)
      .post('/api/qr/issue')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].token).toEqual(expect.any(String));
    expect(res.body.data[0].routeId).toBe(route.routeId);
  });

  it('404s when the caller has no active membership on the requested route', async () => {
    const res = await request(app)
      .post('/api/qr/issue')
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ routeId: route.routeId });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/qr/rotate', () => {
  it('bumps tokenVersion for the caller\'s own membership, revoking prior QRs', async () => {
    const before = await RouteMembership.findById(membership._id);
    const { token: oldToken } = signQr(before);

    const res = await request(app)
      .post('/api/qr/rotate')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId });

    expect(res.status).toBe(200);
    expect(res.body.data.tokenVersion).toBe(before.tokenVersion + 1);

    const oldResult = await verifyQr(oldToken);
    expect(oldResult.valid).toBe(false);
    expect(oldResult.reason).toBe('STALE_VERSION');
  });

  it('allows a manager to rotate a member\'s QR on a route they manage', async () => {
    const res = await request(app)
      .post('/api/qr/rotate')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeId: route.routeId, userId: String(riderId) });

    expect(res.status).toBe(200);
  });

  it('403s a manager rotating on a route they do not manage', async () => {
    const res = await request(app)
      .post('/api/qr/rotate')
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ routeId: route.routeId, userId: String(riderId) });

    expect(res.status).toBe(403);
  });

  it('403s a non-manager rider rotating another rider\'s QR', async () => {
    const otherRider = await User.create({
      name: 'QR Rider 2', email: `qr-rider2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
      role: 'user', isEmailVerified: true, isActive: true
    });
    const otherRiderToken = await loginAs(otherRider.email, 'P@ssw0rd!');

    const res = await request(app)
      .post('/api/qr/rotate')
      .set('Authorization', `Bearer ${otherRiderToken}`)
      .send({ routeId: route.routeId, userId: String(riderId) });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/driver/boarding/scan', () => {
  async function freshTokenForRider() {
    const m = await RouteMembership.findById(membership._id);
    return signQr(m).token;
  }

  it('403s a non-driver caller', async () => {
    const res = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ token: 'x', busId: bus.busId });
    expect(res.status).toBe(403);
  });

  it('401s an invalid QR token', async () => {
    const res = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token: 'garbage', busId: bus.busId });
    expect(res.status).toBe(401);
  });

  it('404s when the bus is not assigned to the scanning driver', async () => {
    const token = await freshTokenForRider();
    const res = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${otherDriverToken}`)
      .send({ token, busId: bus.busId });
    expect(res.status).toBe(404);
  });

  it('403s when the rider\'s membership route does not match the bus route', async () => {
    const otherRoute = await Route.create({
      routeId: `QR-OTHER-${Date.now()}`.toUpperCase(),
      routeName: 'Other Route', source: 'A', destination: 'B', distance: 5, fare: 50,
      managerId, stops: [{ stopName: 'S', order: 1, lat: 1, lng: 1 }], pathPolyline: 'xyz'
    });
    const otherMembership = await RouteMembership.create({
      userId: riderId, routeId: otherRoute.routeId, managerId, status: 'ACTIVE', grantedVia: 'APPROVAL'
    });
    const { token } = signQr(otherMembership);

    const res = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token, busId: bus.busId });
    expect(res.status).toBe(403);

    await RouteMembership.deleteOne({ _id: otherMembership._id });
    await Route.deleteOne({ _id: otherRoute._id });
  });

  it('records a BOARD on first scan (no explicit type = auto-toggle), then ALIGHT on the next, and dispatches a push', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockClear();

    const token1 = await freshTokenForRider();
    const boardRes = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token: token1, busId: bus.busId });

    expect(boardRes.status).toBe(201);
    expect(boardRes.body.debounced).toBe(false);
    expect(boardRes.body.data.type).toBe('BOARD');

    await new Promise((r) => setTimeout(r, 10));
    await Promise.resolve(); // let the fire-and-forget push promise settle
    expect(__mockSendPushNotificationsAsync).toHaveBeenCalled();

    // Bypass debounce for the ALIGHT toggle test by backdating the BOARD event.
    await BoardingEvent.updateOne(
      { _id: boardRes.body.data.eventId },
      { $set: { timestamp: new Date(Date.now() - 60_000) } }
    );

    const token2 = await freshTokenForRider();
    const alightRes = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token: token2, busId: bus.busId });

    expect(alightRes.status).toBe(201);
    expect(alightRes.body.data.type).toBe('ALIGHT');
  });

  it('debounces a duplicate same-type scan within the debounce window (idempotent)', async () => {
    const token1 = await freshTokenForRider();
    const first = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token: token1, busId: bus.busId, type: 'BOARD' });
    expect(first.status).toBe(201);
    expect(first.body.debounced).toBe(false);

    const token2 = await freshTokenForRider();
    const second = await request(app)
      .post('/api/driver/boarding/scan')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ token: token2, busId: bus.busId, type: 'BOARD' });

    expect(second.status).toBe(200);
    expect(second.body.debounced).toBe(true);
    expect(second.body.data.eventId).toBe(first.body.data.eventId);

    const count = await BoardingEvent.countDocuments({ studentId: riderId, busId: bus.busId, type: 'BOARD' });
    expect(count).toBe(1);
  });
});

describe('GET /api/attendance/student/:studentId', () => {
  beforeEach(async () => {
    await BoardingEvent.create({
      studentId: riderId, membershipId: membership._id, busId: bus.busId, routeId: route.routeId,
      driverId, type: 'BOARD', tripId: 'trip-1'
    });
  });

  it('lets the rider read their own attendance history', async () => {
    const res = await request(app)
      .get(`/api/attendance/student/${riderId}`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events.length).toBeGreaterThan(0);
    expect(res.body.data.summary.totalBoard).toBeGreaterThan(0);
  });

  it('403s a non-manager reading another rider\'s attendance', async () => {
    const res = await request(app)
      .get(`/api/attendance/student/${riderId}`)
      .set('Authorization', `Bearer ${otherDriverToken}`);
    expect(res.status).toBe(403);
  });

  it('lets the managing admin read a rider\'s attendance', async () => {
    const res = await request(app)
      .get(`/api/attendance/student/${riderId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/manager/attendance', () => {
  beforeEach(async () => {
    await BoardingEvent.create({
      studentId: riderId, membershipId: membership._id, busId: bus.busId, routeId: route.routeId,
      driverId, type: 'BOARD', tripId: 'trip-2'
    });
  });

  it('returns a per-student rollup scoped to the manager\'s own routes', async () => {
    const res = await request(app)
      .get('/api/manager/attendance')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const entry = res.body.data.find((d) => d.studentId === String(riderId));
    expect(entry).toBeTruthy();
    expect(entry.boardCount).toBeGreaterThan(0);
  });

  it('403s a routeId filter for a route the manager does not manage', async () => {
    const res = await request(app)
      .get('/api/manager/attendance')
      .query({ routeId: route.routeId })
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(res.status).toBe(403);
  });

  it('returns an empty rollup for a manager with no routes', async () => {
    const res = await request(app)
      .get('/api/manager/attendance')
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('POST /api/notifications/device-token', () => {
  it('registers a device token for the caller, idempotently', async () => {
    const res1 = await request(app)
      .post('/api/notifications/device-token')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ token: 'ExponentPushToken[new-device]' });
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/notifications/device-token')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ token: 'ExponentPushToken[new-device]' });
    expect(res2.status).toBe(200);

    const stored = await User.findById(riderId);
    const occurrences = stored.pushTokens.filter((t) => t === 'ExponentPushToken[new-device]').length;
    expect(occurrences).toBe(1);
  });

  it('400s when token is missing', async () => {
    const res = await request(app)
      .post('/api/notifications/device-token')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
