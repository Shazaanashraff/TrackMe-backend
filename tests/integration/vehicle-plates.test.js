const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Number plates are Sri Lankan and are stored canonically, so the same plate
// typed with any spacing or case is one vehicle. These cover the two endpoints a
// manager can write a plate through.

let managerToken;
let managerId;
let otherManagerId;
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

  const other = await Manager.create({
    name: 'Other Plate Manager',
    email: `mgr-plate-other-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  otherManagerId = other._id;

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

    const stored = await Vehicle.findOne({ vehicleId: body.vehicleId }).lean();
    expect(stored.numberPlate).toBe('WP CAB-4321');
  });

  it('accepts a pre-2000 numeric plate', async () => {
    const body = vehicleAccount({ numberPlate: '62-1234' });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    const stored = await Vehicle.findOne({ vehicleId: body.vehicleId }).lean();
    expect(stored.numberPlate).toBe('62-1234');
  });
});

describe('A plate belongs to one vehicle', () => {
  const created = [];

  const add = async (numberPlate) => {
    const body = vehicleAccount({ numberPlate });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);
    if (res.status === 201) created.push(body.vehicleId);
    return res;
  };

  it('refuses a plate already in the fleet', async () => {
    expect((await add('CAB-5001')).status).toBe(201);

    const again = await add('CAB-5001');
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already on vehicle/i);
  });

  it('refuses the same plate written differently', async () => {
    expect((await add('CAB-5002')).status).toBe(201);

    const spaced = await add('cab 5002');
    expect(spaced.status).toBe(409);
  });

  // The registration is national; the province only says where it was issued.
  it('refuses the same registration under another province', async () => {
    expect((await add('WP CAB-5003')).status).toBe(201);

    const elsewhere = await add('CP CAB-5003');
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.message).toMatch(/already on vehicle/i);
  });

  it('refuses a plate held by another manager, without naming their vehicle', async () => {
    await Vehicle.create({
      vehicleId: `THEIRS-${Date.now()}`,
      vehicleName: 'Theirs',
      numberPlate: 'CAB-5004',
      registrationNumber: `REG-THEIRS-${Date.now()}`,
      managerId: otherManagerId
    });

    const res = await add('CAB-5004');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/belongs to another vehicle/i);
    expect(res.body.message).not.toMatch(/THEIRS-/);
  });

  it('refuses a plate held by a deleted vehicle, saying so', async () => {
    await Vehicle.create({
      vehicleId: `GONE-${Date.now()}`,
      vehicleName: 'Gone',
      numberPlate: 'CAB-5005',
      registrationNumber: `REG-GONE-${Date.now()}`,
      managerId,
      isDeleted: true
    });

    const res = await add('CAB-5005');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/deleted vehicle/i);
  });

  it('keeps the database from holding two, even past the checks', async () => {
    await add('CAB-5006');

    // Straight at the model, bypassing every controller guard.
    await expect(Vehicle.create({
      vehicleId: `RAW-${Date.now()}`,
      vehicleName: 'Raw',
      numberPlate: 'WP CAB-5006',
      registrationNumber: `REG-RAW-${Date.now()}`,
      managerId
    })).rejects.toMatchObject({ code: 11000 });
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
