const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Organization = require('../../src/models/Organization');
const DriverEnrollmentKey = require('../../src/models/DriverEnrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// The manager driver directory. A driver belongs to one manager, so the whole
// surface is scoped by that ownership. The cross-manager cases below are the
// point of the suite, not an afterthought.

let managerToken;
let managerId;
let otherManagerId;

const login = (email, password) =>
  request(app).post('/api/auth/login').send({ email, password });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  // Drivers may have no email, which only works against the sparse unique index.
  // A test database created before that change still carries the plain unique
  // one, so bring it in line with the schema first (the migration script does
  // the same thing for real databases).
  await Driver.syncIndexes();

  const manager = await Manager.create({
    name: 'Fleet Manager',
    email: `mgr-drv-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  managerId = manager._id;

  const other = await Manager.create({
    name: 'Other Manager',
    email: `mgr-other-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  otherManagerId = other._id;

  const res = await login(manager.email, 'P@ssw0rd!');
  managerToken = res.body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${managerToken}`];

let seq = 0;
const newDriver = (overrides = {}) => ({
  name: 'Kamal Perera',
  email: `drv-${Date.now()}-${seq++}@t.com`,
  password: 'DriverPass1!',
  phoneNumber: '0771234567',
  ...overrides
});

const createDriver = (body = {}) =>
  request(app).post('/api/manager/drivers').set(...auth()).send(newDriver(body));

describe('GET /api/manager/drivers', () => {
  it('lists only this manager\'s drivers', async () => {
    const mine = await createDriver({ name: 'Mine' });
    await Driver.create({
      name: 'Theirs',
      email: `theirs-${Date.now()}@t.com`,
      password: 'DriverPass1!',
      managerId: otherManagerId
    });

    const res = await request(app).get('/api/manager/drivers').set(...auth());

    expect(res.status).toBe(200);
    const emails = res.body.data.map((d) => d.email);
    expect(emails).toContain(mine.body.data.email);
    expect(res.body.data.every((d) => d.name !== 'Theirs')).toBe(true);
  });

  it('reports the assigned vehicle and setup state', async () => {
    const created = await createDriver({ name: 'Assigned' });
    const driverId = created.body.data._id;

    await Vehicle.create({
      vehicleId: `DRV-VEH-${Date.now()}`,
      vehicleName: 'Shuttle A',
      registrationNumber: `REG-${Date.now()}`,
      numberPlate: `NP-${Date.now()}`,
      routeId: 'R-1',
      driverId,
      managerId,
      seatCapacity: 30
    });

    const res = await request(app).get('/api/manager/drivers').set(...auth());
    const row = res.body.data.find((d) => d._id === driverId);

    expect(row.vehicle).not.toBeNull();
    expect(row.setupComplete).toBe(true);
  });

  it('marks a driver with no vehicle as setup incomplete', async () => {
    const created = await createDriver({ name: 'Unassigned' });

    const res = await request(app).get('/api/manager/drivers').set(...auth());
    const row = res.body.data.find((d) => d._id === created.body.data._id);

    expect(row.vehicle).toBeNull();
    expect(row.setupComplete).toBe(false);
  });
});

describe('POST /api/manager/drivers', () => {
  it('creates a driver, returns an enrollment key, and lets them log in', async () => {
    const body = newDriver();
    const res = await request(app).post('/api/manager/drivers').set(...auth()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.enrollmentKey).toMatch(/^TMD-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

    const loginRes = await login(body.email, body.password);
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe('driver');
  });

  it('never stores the password in plaintext', async () => {
    const body = newDriver();
    await request(app).post('/api/manager/drivers').set(...auth()).send(body);

    const stored = await Driver.findOne({ email: body.email }).select('+password');
    expect(stored.password).not.toBe(body.password);
    expect(stored.password).toMatch(/^\$2[aby]\$/);
  });

  it('rejects an email already used by another account type', async () => {
    const manager = await Manager.findById(managerId);
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send(newDriver({ email: manager.email }));

    expect(res.status).toBe(409);
  });

  it('requires name and password', async () => {
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send({ name: 'No Creds' });

    expect(res.status).toBe(400);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send(newDriver({ password: 'short1!' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/8 characters/i);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send(newDriver({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
  });
});

describe('POST /api/manager/drivers: driver ID and optional email', () => {
  it('gives every new driver a permanent driver ID', async () => {
    const res = await createDriver();

    expect(res.status).toBe(201);
    expect(res.body.data.driverCode).toMatch(/^DRV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  it('creates a driver with no email at all', async () => {
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send({ name: 'No Email', password: 'DriverPass1!', phoneNumber: '0771234567' });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('');
    expect(res.body.data.driverCode).toBeTruthy();

    // The field is absent rather than blank, because a blank would sit in the sparse
    // unique index and collide with the next email-less driver.
    const stored = await Driver.findById(res.body.data._id).lean();
    expect(stored.email).toBeUndefined();
  });

  it('allows more than one driver without an email', async () => {
    const first = await request(app).post('/api/manager/drivers').set(...auth())
      .send({ name: 'Emailless One', password: 'DriverPass1!' });
    const second = await request(app).post('/api/manager/drivers').set(...auth())
      .send({ name: 'Emailless Two', password: 'DriverPass1!' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.driverCode).not.toBe(first.body.data.driverCode);
  });

  it('signs in with the driver ID, with or without its dashes', async () => {
    const created = await request(app).post('/api/manager/drivers').set(...auth())
      .send({ name: 'Code Login', password: 'DriverPass1!' });
    const { driverCode } = created.body.data;

    const dashed = await login(driverCode, 'DriverPass1!');
    expect(dashed.status).toBe(200);
    expect(dashed.body.user.role).toBe('driver');
    expect(dashed.body.user.driverCode).toBe(driverCode);

    const messy = await login(driverCode.replace(/-/g, '').toLowerCase(), 'DriverPass1!');
    expect(messy.status).toBe(200);
  });

  it('rejects a wrong password for a driver ID without leaking which part failed', async () => {
    const created = await request(app).post('/api/manager/drivers').set(...auth())
      .send({ name: 'Wrong Pass', password: 'DriverPass1!' });

    const res = await login(created.body.data.driverCode, 'NotThePassword1!');

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid driver id or password/i);
  });

  it('still signs in by email when the driver has one', async () => {
    const body = newDriver();
    await request(app).post('/api/manager/drivers').set(...auth()).send(body);

    const res = await login(body.email, body.password);
    expect(res.status).toBe(200);
    expect(res.body.user.driverCode).toBeTruthy();
  });

  it('clears the email on update without blocking the next driver', async () => {
    const body = newDriver();
    const created = await request(app).post('/api/manager/drivers').set(...auth()).send(body);

    const res = await request(app)
      .put(`/api/manager/drivers/${created.body.data._id}`)
      .set(...auth())
      .send({ email: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('');
    expect((await Driver.findById(created.body.data._id).lean()).email).toBeUndefined();

    // The freed address can now be given to somebody else.
    const reuse = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ email: body.email }));
    expect(reuse.status).toBe(201);
  });
});

describe('POST /api/manager/drivers: organization', () => {
  it('attaches an existing organization', async () => {
    const org = await Organization.create({ name: `Royal ${Date.now()}`, serviceType: 'SCHOOL' });

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ organizationId: String(org._id) }));

    expect(res.status).toBe(201);
    expect(res.body.data.organization).toMatchObject({
      name: org.name,
      serviceType: 'SCHOOL'
    });

    const listed = await request(app).get('/api/manager/drivers').set(...auth());
    const row = listed.body.data.find((d) => d._id === res.body.data._id);
    expect(row.organization.name).toBe(org.name);
  });

  it('creates a new organization inline and links the driver to it', async () => {
    const name = `Inline Campus ${Date.now()}`;

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ organizationName: name, organizationCategory: 'UNIVERSITY' }));

    expect(res.status).toBe(201);
    expect(res.body.data.organization.name).toBe(name);

    const stored = await Organization.findOne({ name }).lean();
    expect(stored.serviceType).toBe('UNIVERSITY');
  });

  it('refuses a new organization with no category', async () => {
    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ organizationName: 'Category Missing' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/category/i);
  });

  it('refuses an organization id that does not exist', async () => {
    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ organizationId: '6a63e3f967212cbddf637776' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/organization not found/i);
  });

  it('leaves the driver unattached when no organization is given', async () => {
    const res = await createDriver();
    expect(res.body.data.organization).toBeNull();
  });

  it('lists and creates organizations for the manager', async () => {
    const created = await request(app).post('/api/manager/organizations').set(...auth())
      .send({ name: `Manager Made ${Date.now()}`, serviceType: 'OFFICE' });
    expect(created.status).toBe(201);

    const offices = await request(app).get('/api/manager/organizations?serviceType=OFFICE')
      .set(...auth());
    expect(offices.status).toBe(200);
    expect(offices.body.data.some((o) => o._id === created.body.data._id)).toBe(true);

    // A different category must not surface it.
    const schools = await request(app).get('/api/manager/organizations?serviceType=SCHOOL')
      .set(...auth());
    expect(schools.body.data.some((o) => o._id === created.body.data._id)).toBe(false);
  });
});

describe('POST /api/manager/drivers: vehicle number', () => {
  const makeVehicle = async (overrides = {}) => Vehicle.create({
    vehicleId: `VN-${Date.now()}-${seq++}`,
    vehicleName: 'Shuttle C',
    registrationNumber: `REGC-${Date.now()}-${seq}`,
    numberPlate: `NPC-${Date.now()}-${seq}`,
    routeId: 'R-1',
    driverId: otherManagerId, // stand-in previous driver
    managerId,
    seatCapacity: 30,
    ...overrides
  });

  it('assigns a vehicle by its vehicle ID', async () => {
    const vehicle = await makeVehicle();

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ vehicleNumber: vehicle.vehicleId }));

    expect(res.status).toBe(201);
    expect(res.body.data.vehicle.vehicleId).toBe(vehicle.vehicleId);
    expect(String((await Vehicle.findById(vehicle._id)).driverId))
      .toBe(res.body.data._id);
  });

  it('assigns a vehicle by its number plate, however it is cased', async () => {
    const vehicle = await makeVehicle();

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ vehicleNumber: vehicle.numberPlate.toLowerCase() }));

    expect(res.status).toBe(201);
    expect(res.body.data.vehicle.numberPlate).toBe(vehicle.numberPlate);
  });

  it('says so plainly when the vehicle moves off another driver', async () => {
    const previous = await createDriver({ name: 'Previous Driver' });
    const vehicle = await makeVehicle({ driverId: previous.body.data._id });

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ vehicleNumber: vehicle.vehicleId }));

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/moved from Previous Driver/i);
  });

  it('rejects a vehicle number that is not in the fleet, creating nothing', async () => {
    const before = await Driver.countDocuments({ managerId });

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ vehicleNumber: 'NOT-A-BUS' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no vehicle numbered/i);
    expect(await Driver.countDocuments({ managerId })).toBe(before);
  });

  it('refuses a vehicle belonging to another manager', async () => {
    const vehicle = await makeVehicle({ managerId: otherManagerId });

    const res = await request(app).post('/api/manager/drivers').set(...auth())
      .send(newDriver({ vehicleNumber: vehicle.vehicleId }));

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/manager/drivers/:driverId', () => {
  it('updates an owned driver', async () => {
    const created = await createDriver();

    const res = await request(app)
      .put(`/api/manager/drivers/${created.body.data._id}`)
      .set(...auth())
      .send({ name: 'Renamed', phoneNumber: '0759999999', isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(res.body.data.phoneNumber).toBe('0759999999');
    expect(res.body.data.isActive).toBe(false);
  });

  it('refuses to touch another manager\'s driver', async () => {
    const theirs = await Driver.create({
      name: 'Not Yours',
      email: `nope-${Date.now()}@t.com`,
      password: 'DriverPass1!',
      managerId: otherManagerId
    });

    const res = await request(app)
      .put(`/api/manager/drivers/${theirs._id}`)
      .set(...auth())
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await Driver.findById(theirs._id)).name).toBe('Not Yours');
  });
});

describe('PUT /api/manager/drivers/:driverId/password', () => {
  it('sets a new password so the old one stops working', async () => {
    const body = newDriver();
    const created = await request(app).post('/api/manager/drivers').set(...auth()).send(body);

    const res = await request(app)
      .put(`/api/manager/drivers/${created.body.data._id}/password`)
      .set(...auth())
      .send({ password: 'BrandNew1!' });

    expect(res.status).toBe(200);
    expect((await login(body.email, body.password)).status).toBe(401);
    expect((await login(body.email, 'BrandNew1!')).status).toBe(200);
  });
});

describe('Enrollment keys', () => {
  it('returns the same key on repeat reveals', async () => {
    const created = await createDriver();
    const id = created.body.data._id;

    const first = await request(app).get(`/api/manager/drivers/${id}/enrollment-key`).set(...auth());
    const second = await request(app).get(`/api/manager/drivers/${id}/enrollment-key`).set(...auth());

    expect(first.status).toBe(200);
    expect(first.body.data.enrollmentKey).toBe(created.body.enrollmentKey);
    expect(second.body.data.enrollmentKey).toBe(first.body.data.enrollmentKey);
  });

  it('rotates to a different key', async () => {
    const created = await createDriver();
    const id = created.body.data._id;

    const res = await request(app)
      .post(`/api/manager/drivers/${id}/enrollment-key/rotate`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.enrollmentKey).not.toBe(created.body.enrollmentKey);

    const reveal = await request(app).get(`/api/manager/drivers/${id}/enrollment-key`).set(...auth());
    expect(reveal.body.data.enrollmentKey).toBe(res.body.data.enrollmentKey);
  });

  it('never stores the key in plaintext', async () => {
    const created = await createDriver();
    const record = await DriverEnrollmentKey.findOne({ driverId: created.body.data._id }).select(
      '+ciphertext +lookupHash'
    );

    expect(record.ciphertext).not.toContain(created.body.enrollmentKey);
    expect(record.lookupHash).not.toContain(created.body.enrollmentKey);
  });

  it('will not reveal another manager\'s driver key', async () => {
    const theirs = await Driver.create({
      name: 'Not Yours',
      email: `nokey-${Date.now()}@t.com`,
      password: 'DriverPass1!',
      managerId: otherManagerId
    });

    const res = await request(app)
      .get(`/api/manager/drivers/${theirs._id}/enrollment-key`)
      .set(...auth());

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/manager/drivers/:driverId', () => {
  it('deletes an unassigned driver and its enrollment key', async () => {
    const created = await createDriver();
    const id = created.body.data._id;

    const res = await request(app).delete(`/api/manager/drivers/${id}`).set(...auth());

    expect(res.status).toBe(200);
    expect(await Driver.findById(id)).toBeNull();
    expect(await DriverEnrollmentKey.findOne({ driverId: id })).toBeNull();
  });

  it('refuses while the driver is still assigned to a vehicle', async () => {
    const created = await createDriver();
    const id = created.body.data._id;

    await Vehicle.create({
      vehicleId: `BUSY-${Date.now()}`,
      vehicleName: 'Shuttle B',
      registrationNumber: `REGB-${Date.now()}`,
      numberPlate: `NPB-${Date.now()}`,
      routeId: 'R-1',
      driverId: id,
      managerId,
      seatCapacity: 30
    });

    const res = await request(app).delete(`/api/manager/drivers/${id}`).set(...auth());

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/unassign/i);
    expect(await Driver.findById(id)).not.toBeNull();
  });
});

describe('Auth', () => {
  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/manager/drivers');
    expect(res.status).toBe(401);
  });
});
