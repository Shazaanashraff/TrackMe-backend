const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, authHeader } = require('./factories');

// Issue #73: managerController's per-vehicle endpoints (getManagerVehicleById,
// updateManagerVehicle, requestVehicleDelete, resetVehicleAccountPassword) all
// scope through the same getManagedVehicleByVehicleId(managerId, vehicleId)
// helper, which already returns 404 for a vehicle outside the caller's fleet —
// but nothing exercised that branch with real HTTP requests before this file.
// The old smoke test only asserted `typeof managerController[key] === 'function'`.

let managerAToken, managerAId;
let managerBToken;
let routeId;
let vehicleId, driverId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const route = await Route.create({
    routeId: `SCOPE-R-${Date.now()}`,
    routeName: 'Scoping Route',
    source: 'Colombo',
    destination: 'Matara',
    distance: 160,
    fare: 300,
    estimatedTime: 150
  });
  routeId = route.routeId;

  // Fresh, vehicle-less managers so vehicle creation stays on the
  // immediate-creation (bootstrap) path rather than the request/approval one.
  const managerA = await createManager({ name: 'Scoping Owner' });
  managerAToken = managerA.token;
  managerAId = managerA.id;

  const managerB = await createManager({ name: 'Scoping Other' });
  managerBToken = managerB.token;

  const createRes = await request(app).post('/api/manager/vehicle-accounts')
    .set(...authHeader(managerAToken))
    .send({
      vehicleId: `SCOPE-VEH-${Date.now()}`,
      vehicleName: 'Owner Only Bus',
      numberPlate: `CAB-${9000 + Math.floor(Math.random() * 999)}`,
      routeId,
      seatCapacity: 30,
      driverName: 'Owner Only Driver',
      password: 'DriverPass1!'
    });
  vehicleId = createRes.body.data.vehicle.vehicleId;
  driverId = createRes.body.data.driver._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('Manager per-vehicle endpoint scoping (issue #73)', () => {
  it('GET /api/manager/vehicles/:vehicleId — 404s for a vehicle outside the caller\'s fleet', async () => {
    const res = await request(app).get(`/api/manager/vehicles/${vehicleId}`)
      .set(...authHeader(managerBToken));

    expect(res.status).toBe(404);
  });

  it('GET /api/manager/vehicles/:vehicleId — 200s for the owning manager', async () => {
    const res = await request(app).get(`/api/manager/vehicles/${vehicleId}`)
      .set(...authHeader(managerAToken));

    expect(res.status).toBe(200);
    expect(res.body.data.vehicleId).toBe(vehicleId);
  });

  it('PUT /api/manager/vehicles/:vehicleId — 404s and leaves the vehicle unchanged for a non-owning manager', async () => {
    const res = await request(app).put(`/api/manager/vehicles/${vehicleId}`)
      .set(...authHeader(managerBToken))
      .send({ vehicleName: 'Hijacked' });

    expect(res.status).toBe(404);

    const stillOwned = await Vehicle.findOne({ vehicleId });
    expect(stillOwned.vehicleName).toBe('Owner Only Bus');
    expect(String(stillOwned.managerId)).toBe(String(managerAId));
  });

  it('PUT /api/manager/vehicles/:vehicleId — lets the owning manager edit', async () => {
    const res = await request(app).put(`/api/manager/vehicles/${vehicleId}`)
      .set(...authHeader(managerAToken))
      .send({ vehicleName: 'Renamed By Owner' });

    expect(res.status).toBe(200);
    expect(res.body.data.vehicleName).toBe('Renamed By Owner');
  });

  it('POST /api/manager/vehicles/:vehicleId/delete-request — 404s and raises no request for a non-owning manager', async () => {
    const res = await request(app).post(`/api/manager/vehicles/${vehicleId}/delete-request`)
      .set(...authHeader(managerBToken))
      .send({ reason: 'Not mine to delete' });

    expect(res.status).toBe(404);
    expect(await ManagerVehicleRequest.countDocuments({ vehicleId, type: 'DELETE_VEHICLE' })).toBe(0);
  });

  it('PATCH /api/manager/vehicle-accounts/:vehicleId/reset-password — 404s and leaves the driver\'s password unchanged for a non-owning manager', async () => {
    const before = await Driver.findById(driverId).select('+password');

    const res = await request(app).patch(`/api/manager/vehicle-accounts/${vehicleId}/reset-password`)
      .set(...authHeader(managerBToken))
      .send({ password: 'HijackedPass1!' });

    expect(res.status).toBe(404);

    const after = await Driver.findById(driverId).select('+password');
    expect(after.password).toBe(before.password);
  });

  it('PATCH /api/manager/vehicle-accounts/:vehicleId/reset-password — lets the owning manager reset it', async () => {
    const res = await request(app).patch(`/api/manager/vehicle-accounts/${vehicleId}/reset-password`)
      .set(...authHeader(managerAToken))
      .send({ password: 'NewDriverPass1!' });

    expect(res.status).toBe(200);
  });
});
