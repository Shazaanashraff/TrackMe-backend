const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Manager = require('../../src/models/Manager');
const SuperAdmin = require('../../src/models/SuperAdmin');
const User = require('../../src/models/User');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const DriverTrip = require('../../src/models/DriverTrip');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

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

const login = (email) => request(app).post('/api/auth/login')
  .send({ email, password: 'P@ssw0rd!' }).then((res) => res.body.accessToken);

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const ownerManager = await Manager.create({
    name: 'Owner Manager', email: `mgrOwner-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  ownerManagerId = ownerManager._id;
  const otherManager = await Manager.create({
    name: 'Other Manager', email: `mgrOther-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const ownerDriver = await Driver.create({
    name: 'Owner Driver', email: `drvOwner-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  ownerDriverId = ownerDriver._id;
  const otherDriver = await Driver.create({
    name: 'Other Driver', email: `drvOther-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  otherDriverId = otherDriver._id;
  const superAdmin = await SuperAdmin.create({
    name: 'Root Admin', email: `sa-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const rider = await User.create({
    name: 'Rider', email: `rider-trip-${stamp}@t.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });

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

  ownerDriverToken = await login(ownerDriver.email);
  otherDriverToken = await login(otherDriver.email);
  ownerManagerToken = await login(ownerManager.email);
  otherManagerToken = await login(otherManager.email);
  superAdminToken = await login(superAdmin.email);
  riderToken = await login(rider.email);
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
