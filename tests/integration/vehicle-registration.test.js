const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Manager = require('../../src/models/Manager');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// POST /api/vehicle/register (a driver self-registering their vehicle) had zero
// test coverage despite TEST_PLAN_INTEGRATION.md claiming otherwise (issue #18).
// Also covers GET /api/vehicle/list/all?serviceType= filtering, which had none.

let driverToken;
let managerToken;
let routeId;
let schoolRouteId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const driver = await Driver.create({
    name: 'Reg Driver',
    email: `drv-vehreg-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });

  const manager = await Manager.create({
    name: 'Reg Manager',
    email: `mgr-vehreg-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });

  const driverLogin = await request(app).post('/api/auth/login').send({
    email: driver.email, password: 'P@ssw0rd!'
  });
  driverToken = driverLogin.body.accessToken;

  const managerLogin = await request(app).post('/api/auth/login').send({
    email: manager.email, password: 'P@ssw0rd!'
  });
  managerToken = managerLogin.body.accessToken;

  const route = await Route.create({
    routeId: `VEHREG-R-${Date.now()}`,
    routeName: 'Registration Route',
    source: 'Colombo',
    destination: 'Galle',
    distance: 116,
    fare: 200,
    estimatedTime: 90,
    serviceType: 'PUBLIC'
  });
  routeId = route.routeId;

  const schoolRoute = await Route.create({
    routeId: `VEHREG-SR-${Date.now()}`,
    routeName: 'Registration School Route',
    source: 'Colombo',
    destination: 'Nugegoda',
    distance: 12,
    fare: 50,
    estimatedTime: 30,
    serviceType: 'SCHOOL'
  });
  schoolRouteId = schoolRoute.routeId;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

let seq = 0;
const vehiclePayload = (overrides = {}) => ({
  vehicleId: `VEHREG-${Date.now()}-${seq++}`,
  vehicleName: 'Registered Shuttle',
  registrationNumber: `REG-${Date.now()}-${seq}`,
  numberPlate: `CAB-${1000 + seq}`,
  routeId,
  seatCapacity: 40,
  ...overrides
});

describe('POST /api/vehicle/register', () => {
  it('registers a vehicle when called by a driver', async () => {
    const body = vehiclePayload();
    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicleId).toBe(body.vehicleId);
    expect(res.body.data.serviceType).toBe('PUBLIC');

    const stored = await Vehicle.findOne({ vehicleId: body.vehicleId });
    expect(stored).not.toBeNull();
    expect(String(stored.driverId)).toBeTruthy();
  });

  it('refuses a non-driver caller', async () => {
    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(vehiclePayload());

    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).post('/api/vehicle/register').send(vehiclePayload());

    expect(res.status).toBe(401);
  });

  it('rejects a duplicate vehicleId', async () => {
    const body = vehiclePayload();
    const first = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`).send(body);
    expect(first.status).toBe(201);

    const again = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ ...vehiclePayload(), vehicleId: body.vehicleId });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already registered/i);
  });

  it('rejects a numberPlate already on another vehicle', async () => {
    const body = vehiclePayload();
    const first = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`).send(body);
    expect(first.status).toBe(201);

    const again = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(vehiclePayload({ numberPlate: body.numberPlate }));
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unknown routeId', async () => {
    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(vehiclePayload({ routeId: 'NO-SUCH-ROUTE' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid route/i);
  });

  it('rejects a serviceType that does not match the route', async () => {
    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(vehiclePayload({ routeId: schoolRouteId, serviceType: 'OFFICE' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/service type must match route/i);
  });

  it.each([
    ['missing vehicleName', { vehicleName: '' }],
    ['missing registrationNumber', { registrationNumber: '' }],
    ['seatCapacity out of range', { seatCapacity: 500 }],
    ['malformed numberPlate', { numberPlate: 'NOT-A-PLATE' }]
  ])('rejects %s', async (_label, overrides) => {
    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(vehiclePayload(overrides));

    expect(res.status).toBe(400);
  });
});

describe('GET /api/vehicle/list/all?serviceType=', () => {
  beforeAll(async () => {
    await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(vehiclePayload({ routeId: schoolRouteId, serviceType: 'SCHOOL' }));
  });

  it('filters vehicles by serviceType', async () => {
    const res = await request(app).get('/api/vehicle/list/all?serviceType=SCHOOL');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((v) => v.serviceType === 'SCHOOL')).toBe(true);
  });

  it('ignores an invalid serviceType filter (returns unfiltered results)', async () => {
    const res = await request(app).get('/api/vehicle/list/all?serviceType=NOT_A_TYPE');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});
