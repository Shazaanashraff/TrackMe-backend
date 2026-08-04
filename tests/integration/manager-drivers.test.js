const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const DriverEnrollmentKey = require('../../src/models/DriverEnrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// The manager driver directory. A driver belongs to one manager, so the whole
// surface is scoped by that ownership — the cross-manager cases below are the
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

  it('requires name, email and password', async () => {
    const res = await request(app)
      .post('/api/manager/drivers')
      .set(...auth())
      .send({ name: 'No Creds' });

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
