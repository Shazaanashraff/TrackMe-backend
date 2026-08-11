const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, authHeader } = require('./factories');

// A manager owns their own fleet, so POST /api/manager/vehicle-accounts creates
// the vehicle and its driver outright. It used to raise a request for a super
// admin to approve, which left a new manager unable to add anything at all
// until somebody else acted, and unable to add a driver either since the driver
// form needs an existing vehicle.

let managerToken;
let managerId;
let otherManagerId;
let routeId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Fleet Owner' });
  managerId = manager.id;
  managerToken = manager.token;

  // Only ever referenced as somebody else's managerId, so it never signs in.
  const other = await createManager({ name: 'Other Owner', signIn: false });
  otherManagerId = other.id;

  const route = await Route.create({
    routeId: `VEH-R-${Date.now()}`,
    routeName: 'Fleet Route',
    source: 'Colombo',
    destination: 'Galle',
    distance: 116,
    fare: 200,
    estimatedTime: 90
  });
  routeId = route.routeId;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => authHeader(managerToken);

let seq = 0;
const newVehicle = (overrides = {}) => ({
  vehicleId: `FLEET-${Date.now()}-${seq++}`,
  vehicleName: 'Shuttle One',
  numberPlate: `CAB-${1000 + seq}`,
  routeId,
  seatCapacity: 30,
  driverName: 'First Driver',
  password: 'DriverPass1!',
  ...overrides
});

const create = (body = {}) =>
  request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(newVehicle(body));

describe('POST /api/manager/vehicle-accounts', () => {
  it('creates the vehicle straight away, with no request to approve', async () => {
    const body = newVehicle();
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/vehicle created/i);

    const vehicle = await Vehicle.findOne({ vehicleId: body.vehicleId }).lean();
    expect(vehicle).not.toBeNull();
    expect(String(vehicle.managerId)).toBe(String(managerId));
    expect(vehicle.isActive).toBe(true);

    expect(await ManagerVehicleRequest.countDocuments({ vehicleId: body.vehicleId })).toBe(0);
  });

  it('creates the driver against this manager, with an ID and an enrollment key', async () => {
    const res = await create({ driverName: 'Owned Driver' });

    expect(res.status).toBe(201);
    expect(res.body.data.driver.driverCode).toMatch(/^DRV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(res.body.enrollmentKey).toMatch(/^TMD-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    const driver = await Driver.findById(res.body.data.driver._id).lean();
    // Without this the driver would not appear in the manager's own directory.
    expect(String(driver.managerId)).toBe(String(managerId));
  });

  it('lists the new vehicle in the manager fleet', async () => {
    const body = newVehicle();
    await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    const list = await request(app).get('/api/manager/vehicles').set(...auth());
    expect(list.status).toBe(200);
    expect(list.body.data.some((v) => v.vehicleId === body.vehicleId)).toBe(true);
  });

  it('lets the new vehicle be used straight away as a driver vehicle number', async () => {
    const body = newVehicle({ numberPlate: 'PF-2343' });
    await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    const driver = await request(app).post('/api/manager/drivers').set(...auth()).send({
      name: 'Second Driver', password: 'DriverPass1!', vehicleNumber: 'pf- 2343'
    });

    expect(driver.status).toBe(201);
    expect(driver.body.data.vehicle.vehicleId).toBe(body.vehicleId);
  });

  it('creates a driver with no email at all', async () => {
    const res = await create({ driverEmail: '' });

    expect(res.status).toBe(201);
    expect(res.body.data.driver.email).toBe('');
    expect(res.body.data.driver.driverCode).toBeTruthy();
  });

  it('refuses an email that belongs to another manager\'s driver', async () => {
    const theirs = await Driver.create({
      name: 'Theirs', email: `theirs-veh-${Date.now()}@t.com`, password: 'DriverPass1!',
      managerId: otherManagerId
    });

    const res = await create({ driverEmail: theirs.email });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
    // The other manager's driver keeps their password.
    const after = await Driver.findById(theirs._id).select('+password');
    expect(await after.comparePassword('DriverPass1!')).toBe(true);
  });

  it('reuses this manager\'s own driver rather than refusing', async () => {
    const mine = await Driver.create({
      name: 'Mine', email: `mine-veh-${Date.now()}@t.com`, password: 'DriverPass1!',
      managerId
    });

    const res = await create({ driverEmail: mine.email, driverName: 'Mine Renamed' });

    expect(res.status).toBe(201);
    expect(String(res.body.data.driver._id)).toBe(String(mine._id));
    expect((await Driver.findById(mine._id)).name).toBe('Mine Renamed');
  });

  it('refuses a duplicate vehicle ID or plate', async () => {
    const body = newVehicle();
    await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    const again = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);
    expect(again.status).toBe(409);
  });

  it('requires a name, a plate, a route and a password', async () => {
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth())
      .send({ vehicleId: 'NOTHING-ELSE' });

    expect(res.status).toBe(400);
  });

  it('leaves no driver behind when the vehicle cannot be saved', async () => {
    // A soft-deleted vehicle keeps its plate in the unique index, so the
    // duplicate check (which only looks at live vehicles) misses it and the
    // save itself fails. That is the window where a driver could be orphaned.
    const buried = await Vehicle.create({
      vehicleId: `BURIED-${Date.now()}`,
      vehicleName: 'Buried',
      numberPlate: 'CAB-9911',
      registrationNumber: `REG-BURIED-${Date.now()}`,
      managerId,
      isDeleted: true
    });
    expect(buried.isDeleted).toBe(true);

    const before = await Driver.countDocuments({ managerId });

    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth())
      .send(newVehicle({ numberPlate: 'CAB-9911' }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Driver.countDocuments({ managerId })).toBe(before);
  });

  it('creates a vehicle with no driver at all', async () => {
    const body = newVehicle({ driverName: undefined, password: undefined });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.driver).toBeNull();
    expect(res.body.message).toMatch(/add a driver/i);

    const vehicle = await Vehicle.findOne({ vehicleId: body.vehicleId }).lean();
    expect(vehicle.driverId).toBeNull();
  });

  it('creates a vehicle with no route or seat capacity, to be filled in later', async () => {
    const body = newVehicle({
      driverName: undefined, password: undefined, routeId: undefined, seatCapacity: undefined
    });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    const vehicle = await Vehicle.findOne({ vehicleId: body.vehicleId }).lean();
    expect(vehicle.routeId).toBe('');
    expect(vehicle.seatCapacity).toBeNull();
  });

  it('names the vehicle after its plate when no name is given', async () => {
    const body = newVehicle({ vehicleName: undefined, numberPlate: 'CAB-7777' });
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.vehicle.vehicleName).toBe('CAB-7777');
  });

  it('refuses a driver named with no password', async () => {
    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth())
      .send(newVehicle({ password: undefined }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password/i);
  });
});
