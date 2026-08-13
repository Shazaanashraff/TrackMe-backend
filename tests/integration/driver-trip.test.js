const request = require('supertest');
const app = require('../../src/server');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const DriverTrip = require('../../src/models/DriverTrip');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const {
  createManager, createDriver, createSuperAdmin, createRider
} = require('./factories');

// POST /api/driver/trips/log was guarded only by `protect`, despite being
// commented as "admin/system use" — any authenticated account could log a
// fabricated trip for an arbitrary driver/vehicle (issue #40; this endpoint
// replaced the earlier driverEarningsController.log-trip route the issue
// originally named, which no longer exists after the earnings→trip-log
// rewrite, but carried the same missing ownership check forward).

const stamp = Date.now();
let ownerDriverToken, ownerDriverId;
let otherDriverToken, otherDriverId;
let ownerManagerToken, ownerManagerId;
let otherManagerToken;
let superAdminToken;
let riderToken;
let vehicleMongoId, routeMongoId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const ownerManager = await createManager({ name: 'Owner Manager' });
  ownerManagerId = ownerManager.id;
  ownerManagerToken = ownerManager.token;

  ({ token: otherManagerToken } = await createManager({ name: 'Other Manager' }));

  const ownerDriver = await createDriver({ name: 'Owner Driver' });
  ownerDriverId = ownerDriver.id;
  ownerDriverToken = ownerDriver.token;

  const otherDriver = await createDriver({ name: 'Other Driver' });
  otherDriverId = otherDriver.id;
  otherDriverToken = otherDriver.token;

  ({ token: superAdminToken } = await createSuperAdmin({ name: 'Root Admin' }));
  ({ token: riderToken } = await createRider({ name: 'Rider' }));

  const route = await Route.create({
    routeId: `TRIP-R-${stamp}`, routeName: 'Trip Route',
    source: 'Colombo', destination: 'Kandy', distance: 100, fare: 200, estimatedTime: 120
  });
  routeMongoId = route._id;

  const vehicle = await Vehicle.create({
    vehicleId: `TRIP-V-${stamp}`,
    vehicleName: 'Trip Bus',
    registrationNumber: `REGTRIP-${stamp}`,
    numberPlate: `CAT-${1000 + (stamp % 900)}`,
    routeId: route.routeId,
    driverId: ownerDriverId,
    managerId: ownerManagerId
  });
  vehicleMongoId = vehicle._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const tripPayload = (driverId) => ({
  driverId: driverId.toString(),
  vehicleId: vehicleMongoId.toString(),
  routeId: routeMongoId.toString(),
  journeyDate: new Date().toISOString(),
  startTime: new Date().toISOString(),
  endTime: new Date().toISOString()
});

describe('POST /api/driver/trips/log ownership', () => {
  it('refuses a rider (no driver/manager relationship at all)', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${riderToken}`)
      .send(tripPayload(ownerDriverId));

    expect(res.status).toBe(403);
  });

  it('refuses a driver who is not assigned to the vehicle', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${otherDriverToken}`)
      .send(tripPayload(otherDriverId));

    expect(res.status).toBe(403);
  });

  it('refuses a driver assigned to the vehicle logging a trip under someone else\'s driverId', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${ownerDriverToken}`)
      .send(tripPayload(otherDriverId));

    expect(res.status).toBe(403);
  });

  it('refuses a manager who does not manage the vehicle', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send(tripPayload(ownerDriverId));

    expect(res.status).toBe(403);
  });

  it('lets the assigned driver log their own trip', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${ownerDriverToken}`)
      .send(tripPayload(ownerDriverId));

    expect(res.status).toBe(201);
    const stored = await DriverTrip.findOne({ driverId: ownerDriverId, vehicleId: vehicleMongoId });
    expect(stored).not.toBeNull();
  });

  it('lets the managing manager log a trip for their vehicle', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${ownerManagerToken}`)
      .send(tripPayload(ownerDriverId));

    expect(res.status).toBe(201);
  });

  it('lets a super-admin log a trip for any vehicle', async () => {
    const res = await request(app).post('/api/driver/trips/log')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(tripPayload(ownerDriverId));

    expect(res.status).toBe(201);
  });
});
