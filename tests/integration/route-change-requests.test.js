const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Bus = require('../../src/models/Bus');
const Route = require('../../src/models/Route');
const RouteChangeRequest = require('../../src/models/RouteChangeRequest');
const Notification = require('../../src/models/Notification');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Phase 2: end-of-journey off-route detection -> RouteChangeRequest -> manager
// resolves (keep old / adopt new). Covers report-journey, record-update, and
// the manager resolve endpoint, including dedupe and idempotency.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

// A straight north-south line ~1.11km long.
const ROUTE_START = { lat: 6.9271, lng: 79.8612 };
const ROUTE_END = { lat: 6.9371, lng: 79.8612 };
const ON_ROUTE_BREADCRUMB = [
  ROUTE_START,
  { lat: 6.9321, lng: 79.8612 },
  ROUTE_END
];
// Shifted ~500m east of the whole line -> every point is off-route.
const OFF_ROUTE_BREADCRUMB = [
  { lat: 6.9271, lng: 79.8657 },
  { lat: 6.9321, lng: 79.8657 },
  { lat: 6.9371, lng: 79.8657 }
];

let managerToken, managerId, otherManagerToken, superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await User.create({
    name: 'RCR Manager', email: `rcr-mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  managerId = manager._id;
  managerToken = await loginAs(manager.email, 'P@ssw0rd!');

  const otherManager = await User.create({
    name: 'RCR Other Manager', email: `rcr-mgr2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  otherManagerToken = await loginAs(otherManager.email, 'P@ssw0rd!');

  const superAdmin = await User.create({
    name: 'RCR Super Admin', email: `rcr-sa-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'super-admin', isEmailVerified: true, isActive: true
  });
  superAdminToken = await loginAs(superAdmin.email, 'P@ssw0rd!');
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

async function createActiveCustomRoute() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const createRes = await request(app)
    .post('/api/manager/bus-accounts')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({
      busId: `RCR-BUS-${suffix}`,
      busName: 'Shuttle',
      numberPlate: `RCR-${suffix}`,
      routeMode: 'CUSTOM',
      seatCapacity: 20,
      driverName: 'Shuttle Driver',
      driverEmail: `rcr-driver-${suffix}@test.com`,
      password: 'Driver@123'
    });
  expect(createRes.status).toBe(201);

  const approveRes = await request(app)
    .patch(`/api/super-admin/bus-requests/${createRes.body.data._id}/review`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ decision: 'APPROVE' });
  expect(approveRes.status).toBe(200);

  const bus = await Bus.findOne({ busId: `RCR-BUS-${suffix}` });
  const driverToken = await loginAs(`rcr-driver-${suffix}@test.com`, 'Driver@123');

  const recordRes = await request(app)
    .post('/api/driver/custom-routes/record')
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      busId: bus.busId,
      breadcrumb: ON_ROUTE_BREADCRUMB,
      stops: [{ lat: ROUTE_START.lat, lng: ROUTE_START.lng, stopName: 'Start' }]
    });
  expect(recordRes.status).toBe(200);

  const nameRes = await request(app)
    .patch(`/api/manager/custom-routes/${bus.routeId}/name`)
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ routeName: 'Deviation Test Route' });
  expect(nameRes.status).toBe(200);

  return { bus, driverToken, routeId: bus.routeId };
}

describe('POST /api/driver/custom-routes/:routeId/report-journey', () => {
  it('does not flag a journey that tracks the saved route', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const res = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: ON_ROUTE_BREADCRUMB });

    expect(res.status).toBe(200);
    expect(res.body.data.flagged).toBe(false);

    const requests = await RouteChangeRequest.find({ busId: bus._id });
    expect(requests).toHaveLength(0);
  });

  it('flags a sustained off-route journey and creates exactly one RouteChangeRequest + notification', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const res = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB });

    expect(res.status).toBe(200);
    expect(res.body.data.flagged).toBe(true);
    expect(res.body.data.changeRequestId).toBeTruthy();

    const requests = await RouteChangeRequest.find({ busId: bus._id });
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('PENDING');
    expect(requests[0].deviation.maxMeters).toBeGreaterThan(150);

    const notifications = await Notification.find({ userId: bus.managerId, type: 'ROUTE_UPDATE' });
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });

  it('does not create a second PENDING request while one already exists (dedupe)', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const first = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB });
    const second = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB });

    expect(String(first.body.data.changeRequestId)).toBe(String(second.body.data.changeRequestId));
    const requests = await RouteChangeRequest.find({ busId: bus._id });
    expect(requests).toHaveLength(1);
  });

  it('rejects a too-short breadcrumb', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const res = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: [ROUTE_START] });
    expect(res.status).toBe(400);
  });

  it('rejects reporting on a route that is not yet named (PENDING_NAMING)', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const createRes = await request(app)
      .post('/api/manager/bus-accounts')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        busId: `RCR-PN-${suffix}`, busName: 'Shuttle', numberPlate: `RCRPN-${suffix}`,
        routeMode: 'CUSTOM', seatCapacity: 20, driverName: 'D', driverEmail: `rcr-pn-${suffix}@test.com`, password: 'Driver@123'
      });
    await request(app)
      .patch(`/api/super-admin/bus-requests/${createRes.body.data._id}/review`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ decision: 'APPROVE' });
    const bus = await Bus.findOne({ busId: `RCR-PN-${suffix}` });
    const driverToken = await loginAs(`rcr-pn-${suffix}@test.com`, 'Driver@123');

    const res = await request(app)
      .post(`/api/driver/custom-routes/${bus.routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: ON_ROUTE_BREADCRUMB });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/driver/custom-routes/:routeId/record-update', () => {
  it('creates a candidate with stops for manager review', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const res = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/record-update`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        busId: bus.busId,
        breadcrumb: OFF_ROUTE_BREADCRUMB,
        stops: [{ lat: OFF_ROUTE_BREADCRUMB[0].lat, lng: OFF_ROUTE_BREADCRUMB[0].lng, stopName: 'New Start' }]
      });

    expect(res.status).toBe(200);
    const changeRequest = await RouteChangeRequest.findById(res.body.data.changeRequestId);
    expect(changeRequest.candidate.stops).toHaveLength(1);
    expect(changeRequest.candidate.stops[0].stopName).toBe('New Start');
  });

  it('updates the existing PENDING request instead of creating a duplicate', async () => {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB });

    await request(app)
      .post(`/api/driver/custom-routes/${routeId}/record-update`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB, stops: [] });

    const requests = await RouteChangeRequest.find({ busId: bus._id });
    expect(requests).toHaveLength(1);
  });
});

describe('PATCH /api/manager/route-change-requests/:id/resolve', () => {
  async function flaggedRequest() {
    const { bus, driverToken, routeId } = await createActiveCustomRoute();
    const res = await request(app)
      .post(`/api/driver/custom-routes/${routeId}/report-journey`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ busId: bus.busId, breadcrumb: OFF_ROUTE_BREADCRUMB });
    return { bus, routeId, changeRequestId: res.body.data.changeRequestId };
  }

  it('lists PENDING requests for the owning manager', async () => {
    const { changeRequestId } = await flaggedRequest();
    const res = await request(app)
      .get('/api/manager/route-change-requests?status=PENDING')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.body.data.some((r) => String(r._id) === String(changeRequestId))).toBe(true);
  });

  it('KEEP_OLD leaves the route geometry unchanged and marks resolved', async () => {
    const { routeId, changeRequestId } = await flaggedRequest();
    const before = await Route.findOne({ routeId });

    const res = await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ resolution: 'KEEP_OLD' });

    expect(res.status).toBe(200);
    const after = await Route.findOne({ routeId });
    expect(after.pathPolyline).toBe(before.pathPolyline);

    const changeRequest = await RouteChangeRequest.findById(changeRequestId);
    expect(changeRequest.status).toBe('RESOLVED');
    expect(changeRequest.resolution).toBe('KEEP_OLD');
  });

  it('ADOPT_NEW overwrites the route geometry from the candidate', async () => {
    const { routeId, changeRequestId } = await flaggedRequest();
    const changeRequestBefore = await RouteChangeRequest.findById(changeRequestId);

    const res = await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ resolution: 'ADOPT_NEW' });

    expect(res.status).toBe(200);
    const after = await Route.findOne({ routeId });
    expect(after.pathPolyline).toBe(changeRequestBefore.candidate.pathPolyline);
    expect(after.distance).toBe(changeRequestBefore.candidate.distance);
    // Auto-flagged (report-journey) candidates carry no stops -> original stops preserved.
    expect(after.stops).toHaveLength(1);
    expect(after.stops[0].stopName).toBe('Start');
  });

  it('is idempotent: resolving an already-RESOLVED request twice does not reprocess it', async () => {
    const { routeId, changeRequestId } = await flaggedRequest();
    await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ resolution: 'ADOPT_NEW' });
    const afterFirst = await Route.findOne({ routeId });

    const secondRes = await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ resolution: 'KEEP_OLD' }); // different resolution — should be ignored since already resolved

    expect(secondRes.status).toBe(200);
    const afterSecond = await Route.findOne({ routeId });
    expect(afterSecond.pathPolyline).toBe(afterFirst.pathPolyline);
    const changeRequest = await RouteChangeRequest.findById(changeRequestId);
    expect(changeRequest.resolution).toBe('ADOPT_NEW'); // unchanged from first resolution
  });

  it("404s when another manager tries to resolve someone else's request", async () => {
    const { changeRequestId } = await flaggedRequest();
    const res = await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ resolution: 'KEEP_OLD' });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid resolution value', async () => {
    const { changeRequestId } = await flaggedRequest();
    const res = await request(app)
      .patch(`/api/manager/route-change-requests/${changeRequestId}/resolve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ resolution: 'MAYBE' });
    expect(res.status).toBe(400);
  });
});
