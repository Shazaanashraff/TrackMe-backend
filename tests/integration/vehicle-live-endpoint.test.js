const request = require('supertest');
const app = require('../../src/server');
const Vehicle = require('../../src/models/Vehicle');
const VehicleLiveLocation = require('../../src/models/VehicleLiveLocation');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const RiderProfile = require('../../src/models/RiderProfile');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, createDriver, createManager, authHeader } = require('./factories');

// REST reads of live position: GET /api/vehicle/:vehicleId/live and
// GET /api/manager/vehicles/live. These are the socket:subscribe authorization
// rules re-checked over HTTP, so the cases are the same shape as the WS suite —
// every status code, and both the wrong-role and the right-role/wrong-owner
// failure for each caller type.

let manager;
let otherManager;
let driver;
let rider;
let riderProfile;
let vehicle;

const stamp = Date.now();

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  manager = await createManager({ name: 'Fleet Manager' });
  otherManager = await createManager({ name: 'Other Manager' });
  driver = await createDriver({ name: 'Fleet Driver', fields: { managerId: manager.id } });
  rider = await createRider({ name: 'Fleet Rider' });

  riderProfile = await RiderProfile.create({
    _id: rider.id,
    accountId: rider.id,
    riderCode: `TMR-REST-${stamp}`,
    fullName: 'Fleet Rider'
  });

  vehicle = await Vehicle.create({
    vehicleId: `REST-V-${stamp}`,
    vehicleName: 'REST Shuttle',
    registrationNumber: `REST-REG-${stamp}`,
    numberPlate: `RV-${stamp}`.slice(0, 12),
    driverId: driver.id,
    managerId: manager.id,
    routeId: ''
  });

  await DriverEnrollment.create({
    studentId: riderProfile._id,
    driverId: driver.id,
    managerId: manager.id,
    status: 'ACTIVE'
  });

  await VehicleLiveLocation.create({
    vehicleId: vehicle.vehicleId,
    vehicleRef: vehicle._id,
    driverId: driver.id,
    managerId: manager.id,
    lat: 6.9271,
    lng: 79.8612,
    live: true,
    receivedAt: new Date()
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/vehicle/:vehicleId/live', () => {
  test('401 with no token', async () => {
    const res = await request(app).get(`/api/vehicle/${vehicle.vehicleId}/live`);
    expect(res.status).toBe(401);
  });

  test('404 for a vehicle that does not exist', async () => {
    const res = await request(app)
      .get('/api/vehicle/NO-SUCH-VEHICLE/live')
      .set(...authHeader(manager.token));
    expect(res.status).toBe(404);
  });

  test('an enrolled rider gets 200 with the current position', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live?riderId=${riderProfile._id}`)
      .set(...authHeader(rider.token));
    expect(res.status).toBe(200);
    expect(res.body.data.live).toBe(true);
    expect(res.body.data.location.lat).toBeCloseTo(6.9271, 4);
  });

  test('400 when a rider omits riderId', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live`)
      .set(...authHeader(rider.token));
    expect(res.status).toBe(400);
  });

  test('403 for a rider not enrolled with this vehicle', async () => {
    const stranger = await createRider({ name: 'Unenrolled' });
    const strangerProfile = await RiderProfile.create({
      accountId: stranger.id,
      riderCode: `TMR-REST-STR-${stamp}`,
      fullName: 'Unenrolled'
    });
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live?riderId=${strangerProfile._id}`)
      .set(...authHeader(stranger.token));
    expect(res.status).toBe(403);
  });

  test('404 when the riderId does not belong to the caller', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live?riderId=${riderProfile._id}`)
      .set(...authHeader((await createRider({ name: 'Someone Else' })).token));
    expect(res.status).toBe(404);
  });

  test('the owning manager gets 200', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live`)
      .set(...authHeader(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data.vehicle.numberPlate).toBe(vehicle.numberPlate);
  });

  test('403 for a manager who does not own this vehicle', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live`)
      .set(...authHeader(otherManager.token));
    expect(res.status).toBe(403);
  });

  test('the assigned driver gets 200', async () => {
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live`)
      .set(...authHeader(driver.token));
    expect(res.status).toBe(200);
  });

  test('403 for a different driver', async () => {
    const otherDriver = await createDriver({ name: 'Other Driver', fields: { managerId: manager.id } });
    const res = await request(app)
      .get(`/api/vehicle/${vehicle.vehicleId}/live`)
      .set(...authHeader(otherDriver.token));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/manager/vehicles/live', () => {
  test('401 with no token', async () => {
    const res = await request(app).get('/api/manager/vehicles/live');
    expect(res.status).toBe(401);
  });

  test('403 for a rider', async () => {
    const res = await request(app)
      .get('/api/manager/vehicles/live')
      .set(...authHeader(rider.token));
    expect(res.status).toBe(403);
  });

  test("the owning manager sees their vehicle and not another manager's", async () => {
    const otherDriver = await createDriver({ name: 'Rival Driver', fields: { managerId: otherManager.id } });
    await Vehicle.create({
      vehicleId: `REST-RIVAL-${stamp}`,
      vehicleName: 'Rival Shuttle',
      registrationNumber: `REST-RIVAL-REG-${stamp}`,
      numberPlate: `RX-${stamp}`.slice(0, 12),
      driverId: otherDriver.id,
      managerId: otherManager.id,
      routeId: ''
    });

    const res = await request(app)
      .get('/api/manager/vehicles/live')
      .set(...authHeader(manager.token));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((row) => row.vehicleId);
    expect(ids).toContain(vehicle.vehicleId);
    expect(ids).not.toContain(`REST-RIVAL-${stamp}`);

    const mine = res.body.data.find((row) => row.vehicleId === vehicle.vehicleId);
    expect(mine.live).toBe(true);
  });
});
