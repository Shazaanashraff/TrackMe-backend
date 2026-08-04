const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const SuperAdmin = require('../../src/models/SuperAdmin');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Full custom-route lifecycle: manager requests a CUSTOM driver -> super admin
// approves (provisional PRIVATE route auto-created) -> driver records the route
// -> manager names it (ACTIVE) -> route is reusable for the manager but never
// leaks into any public/user-facing/other-manager path.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

let managerToken, managerId;
let otherManagerToken;
let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await Manager.create({
    name: 'Custom Manager', email: `mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  managerId = manager._id;
  managerToken = await loginAs(manager.email, 'P@ssw0rd!');

  const otherManager = await Manager.create({
    name: 'Other Manager', email: `mgr2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  otherManagerToken = await loginAs(otherManager.email, 'P@ssw0rd!');

  const superAdmin = await SuperAdmin.create({
    name: 'Super Admin', email: `sa-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  superAdminToken = await loginAs(superAdmin.email, 'P@ssw0rd!');
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

async function createAndApproveCustomDriver(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const createRes = await request(app)
    .post('/api/manager/vehicle-accounts')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({
      vehicleId: `CUST-VEHICLE-${suffix}`,
      vehicleName: 'Shuttle',
      numberPlate: `PLT-${suffix}`,
      routeMode: 'CUSTOM',
      seatCapacity: 20,
      driverName: 'Shuttle Driver',
      driverEmail: `driver-${suffix}@test.com`,
      password: 'Driver@123',
      ...overrides
    });

  expect(createRes.status).toBe(201);
  const requestId = createRes.body.data._id;

  const approveRes = await request(app)
    .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ decision: 'APPROVE' });

  expect(approveRes.status).toBe(200);

  const vehicle = await Vehicle.findOne({ vehicleId: `CUST-VEHICLE-${suffix}` });
  const driverToken = await loginAs(`driver-${suffix}@test.com`, 'Driver@123');
  return { vehicle, driverToken, suffix };
}

describe('Custom route provisioning', () => {
  it('provisions a PRIVATE PENDING_NAMING route and assigns it to the vehicle on approval', async () => {
    const { vehicle } = await createAndApproveCustomDriver();

    expect(vehicle).toBeTruthy();
    const route = await Route.findOne({ routeId: vehicle.routeId });
    expect(route).toBeTruthy();
    expect(route.visibility).toBe('PRIVATE');
    expect(route.status).toBe('PENDING_NAMING');
    expect(route.origin).toBe('RECORDED');
    expect(String(route.managerId)).toBe(String(managerId));
  });

  it('rejects CUSTOM requests missing required non-route fields', async () => {
    const res = await request(app)
      .post('/api/manager/vehicle-accounts')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeMode: 'CUSTOM' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/driver/custom-routes/record', () => {
  it('fills the provisional route from a valid breadcrumb + stops', async () => {
    const { vehicle, driverToken } = await createAndApproveCustomDriver();

    const breadcrumb = [
      { lat: 6.9271, lng: 79.8612 },
      { lat: 6.9321, lng: 79.8612 },
      { lat: 6.9371, lng: 79.8612 }
    ];
    const stops = [{ lat: 6.9271, lng: 79.8612, stopName: 'Start' }, { lat: 6.9371, lng: 79.8612, stopName: 'End' }];

    const res = await request(app)
      .post('/api/driver/custom-routes/record')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ vehicleId: vehicle.vehicleId, breadcrumb, stops });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_NAMING');
    expect(res.body.data.stopsCount).toBe(2);

    const route = await Route.findOne({ routeId: vehicle.routeId });
    expect(route.pathPolyline).toBeTruthy();
    expect(route.stops).toHaveLength(2);
    expect(route.recordedMeta.rawPointCount).toBe(3);
  });

  it('rejects a too-short recording', async () => {
    const { vehicle, driverToken } = await createAndApproveCustomDriver();

    const res = await request(app)
      .post('/api/driver/custom-routes/record')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ vehicleId: vehicle.vehicleId, breadcrumb: [{ lat: 6.9271, lng: 79.8612 }], stops: [] });

    expect(res.status).toBe(400);
  });

  it("rejects recording onto a vehicle the driver doesn't own", async () => {
    const { vehicle } = await createAndApproveCustomDriver();
    const { driverToken: otherDriverToken } = await createAndApproveCustomDriver();

    const res = await request(app)
      .post('/api/driver/custom-routes/record')
      .set('Authorization', `Bearer ${otherDriverToken}`)
      .send({
        vehicleId: vehicle.vehicleId,
        breadcrumb: [{ lat: 6.9271, lng: 79.8612 }, { lat: 6.9371, lng: 79.8612 }],
        stops: []
      });

    expect(res.status).toBe(404);
  });
});

describe('Manager naming + reuse', () => {
  async function recordedRoute() {
    const { vehicle, driverToken } = await createAndApproveCustomDriver();
    await request(app)
      .post('/api/driver/custom-routes/record')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        vehicleId: vehicle.vehicleId,
        breadcrumb: [{ lat: 6.9271, lng: 79.8612 }, { lat: 6.9371, lng: 79.8612 }],
        stops: [{ lat: 6.9271, lng: 79.8612 }]
      });
    return vehicle;
  }

  it('names a recorded route, activating it', async () => {
    const vehicle = await recordedRoute();

    const res = await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeName: 'Morning School Run' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.routeName).toBe('Morning School Run');
  });

  it('rejects naming an un-recorded (empty) route', async () => {
    const { vehicle } = await createAndApproveCustomDriver();
    const res = await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeName: 'Too Early' });
    expect(res.status).toBe(409);
  });

  it("404s when another manager tries to name someone else's route", async () => {
    const vehicle = await recordedRoute();
    const res = await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ routeName: 'Hijacked' });
    expect(res.status).toBe(404);
  });

  it('lists PENDING_NAMING and ACTIVE routes for the owning manager only', async () => {
    const vehicle = await recordedRoute();
    await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeName: 'Reusable Route' });

    const activeList = await request(app)
      .get('/api/manager/custom-routes?status=ACTIVE')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(activeList.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(true);

    const otherList = await request(app)
      .get('/api/manager/custom-routes?status=ACTIVE')
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(otherList.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(false);
  });

  it('makes a named private route available in the assignable-routes dropdown for its manager only', async () => {
    const vehicle = await recordedRoute();
    await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeName: 'Dropdown Route' });

    const ownDropdown = await request(app)
      .get('/api/manager/routes')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(ownDropdown.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(true);

    const otherDropdown = await request(app)
      .get('/api/manager/routes')
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(otherDropdown.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(false);
  });
});

describe('Visibility: a PRIVATE custom route never leaks into public paths', () => {
  async function activeCustomRoute() {
    const { vehicle, driverToken } = await createAndApproveCustomDriver();
    await request(app)
      .post('/api/driver/custom-routes/record')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        vehicleId: vehicle.vehicleId,
        breadcrumb: [{ lat: 6.9271, lng: 79.8612 }, { lat: 6.9371, lng: 79.8612 }],
        stops: [{ lat: 6.9271, lng: 79.8612 }]
      });
    await request(app)
      .patch(`/api/manager/custom-routes/${vehicle.routeId}/name`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ routeName: 'Hidden Route' });
    return vehicle;
  }

  it('is absent from GET /api/routes (public list)', async () => {
    const vehicle = await activeCustomRoute();
    const res = await request(app).get('/api/routes');
    expect(res.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(false);
  });

  it('404s on GET /api/routes/:routeId (public single-route fetch)', async () => {
    const vehicle = await activeCustomRoute();
    const res = await request(app).get(`/api/routes/${vehicle.routeId}`);
    expect(res.status).toBe(404);
  });

  it('is absent from GET /api/vehicle/routes', async () => {
    const vehicle = await activeCustomRoute();
    const res = await request(app).get('/api/vehicle/routes');
    expect(res.body.data.some((r) => r.routeId === vehicle.routeId)).toBe(false);
  });

  it('returns no vehicles from GET /api/vehicle/route/:routeId', async () => {
    const vehicle = await activeCustomRoute();
    const res = await request(app).get(`/api/vehicle/route/${vehicle.routeId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('is excluded from GET /api/vehicle/stops', async () => {
    const vehicle = await activeCustomRoute();
    const route = await Route.findOne({ routeId: vehicle.routeId });
    const stopName = route.stops[0]?.stopName;
    const res = await request(app).get('/api/vehicle/stops');
    expect(res.body.data.some((s) => s.stopName === stopName)).toBe(false);
  });

  it('404s on GET /api/vehicle/routes/:routeId/path (geometry)', async () => {
    const vehicle = await activeCustomRoute();
    const res = await request(app).get(`/api/vehicle/routes/${vehicle.routeId}/path`);
    expect(res.status).toBe(404);
  });

  it('cannot be assigned to another vehicle by a non-owning manager', async () => {
    const vehicle = await activeCustomRoute();

    const updateRes = await request(app)
      .put(`/api/vehicle/${vehicle.vehicleId}`)
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ routeId: vehicle.routeId });
    expect(updateRes.status).toBe(403); // other manager doesn't manage this vehicle at all
  });
});
