const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Number plates are Sri Lankan and are stored canonically, so the same plate
// typed with any spacing or case is one vehicle. These cover the two endpoints a
// manager can write a plate through.

let managerToken;
let managerId;
let routeId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const manager = await Manager.create({
    name: 'Plate Manager',
    email: `mgr-plate-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  managerId = manager._id;

  const route = await Route.create({
    routeId: `PLATE-R-${Date.now()}`,
    routeName: 'Plate Test Route',
    source: 'Colombo',
    destination: 'Kandy',
    distance: 115,
    fare: 100,
    estimatedTime: 60
  });
  routeId = route.routeId;

  const res = await request(app).post('/api/auth/login').send({
    email: manager.email, password: 'P@ssw0rd!'
  });
  managerToken = res.body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${managerToken}`];

let seq = 0;
const vehicleAccount = (overrides = {}) => ({
  vehicleId: `PLATE-V-${Date.now()}-${seq++}`,
  vehicleName: 'Shuttle P',
  numberPlate: 'CAB-1234',
  routeId,
  seatCapacity: 30,
  driverName: 'Plate Driver',
  driverEmail: `plate-drv-${Date.now()}-${seq}@t.com`,
  password: 'DriverPass1!',
  ...overrides
});

describe('POST /api/manager/vehicle-accounts', () => {
  it('rejects a plate that is not a Sri Lankan one', async () => {
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth())
      .send(vehicleAccount({ numberPlate: 'NOT-A-PLATE' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Sri Lankan number plate/i);
  });

  it.each([
    ['CAB-123', 'three digits'],
    ['CABX-1234', 'four letters'],
    ['ZZ CAB-1234', 'an unknown province']
  ])('rejects %s (%s)', async (numberPlate) => {
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth())
      .send(vehicleAccount({ numberPlate }));

    expect(res.status).toBe(400);
  });

  it('stores the canonical plate whatever spacing was typed', async () => {
    const body = vehicleAccount({ numberPlate: 'wp cab 4321' });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);

    const stored = await ManagerVehicleRequest.findOne({ vehicleId: body.vehicleId }).lean();
    expect(stored.payload.vehicle.numberPlate).toBe('WP CAB-4321');
  });

  it('accepts a pre-2000 numeric plate', async () => {
    const body = vehicleAccount({ numberPlate: '62-1234' });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    const stored = await ManagerVehicleRequest.findOne({ vehicleId: body.vehicleId }).lean();
    expect(stored.payload.vehicle.numberPlate).toBe('62-1234');
  });
});

describe('PUT /api/manager/vehicles/:vehicleId', () => {
  const makeVehicle = async () => {
    const driver = await Driver.create({
      name: 'Owned Driver',
      email: `owned-${Date.now()}-${seq++}@t.com`,
      password: 'DriverPass1!',
      managerId
    });

    return Vehicle.create({
      vehicleId: `PLATE-OWN-${Date.now()}-${seq}`,
      vehicleName: 'Shuttle Q',
      registrationNumber: `REGQ-${Date.now()}-${seq}`,
      numberPlate: `NP-${1000 + seq}`,
      routeId,
      driverId: driver._id,
      managerId,
      seatCapacity: 30
    });
  };

  it('rejects a malformed plate and leaves the old one in place', async () => {
    const vehicle = await makeVehicle();

    const res = await request(app).put(`/api/manager/vehicles/${vehicle.vehicleId}`).set(...auth())
      .send({ numberPlate: 'ABC-12' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Sri Lankan number plate/i);
    expect((await Vehicle.findById(vehicle._id)).numberPlate).toBe(vehicle.numberPlate);
  });

  it('saves the canonical form of an accepted plate', async () => {
    const vehicle = await makeVehicle();

    const res = await request(app).put(`/api/manager/vehicles/${vehicle.vehicleId}`).set(...auth())
      .send({ numberPlate: 'pf- 2327' });

    expect(res.status).toBe(200);
    expect((await Vehicle.findById(vehicle._id)).numberPlate).toBe('PF-2327');
  });
});
