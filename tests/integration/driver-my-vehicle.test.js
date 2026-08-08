const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// GET /api/vehicle/my-vehicle. The driver app reads the owning driver off this
// payload to show whether enrolment with their key needs the manager's approval,
// so the populated driver has to carry isPrivate and nothing more than it needs.

let managerId;

const login = (email, password) =>
  request(app).post('/api/auth/login').send({ email, password });

const stamp = Date.now();
let seq = 0;

async function makeDriverWithVehicle({ isPrivate }) {
  const n = seq++;
  const driver = await Driver.create({
    name: `MV Driver ${n}`,
    email: `mv-drv-${stamp}-${n}@t.com`,
    password: 'P@ssw0rd!',
    managerId,
    isPrivate,
    isActive: true,
    isEmailVerified: true
  });

  await Vehicle.create({
    vehicleId: `MV-V-${stamp}-${n}`,
    vehicleName: `Shuttle ${n}`,
    registrationNumber: `MV-REG-${stamp}-${n}`,
    numberPlate: `CAB-${1000 + n}`,
    driverId: driver._id,
    managerId
  });

  const token = (await login(driver.email, 'P@ssw0rd!')).body.accessToken;
  return { driver, token };
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const manager = await Manager.create({
    name: 'My Vehicle Manager',
    email: `mgr-mv-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  managerId = manager._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/vehicle/my-vehicle', () => {
  it('reports a private driver so the app can say enrolment needs approval', async () => {
    const { token } = await makeDriverWithVehicle({ isPrivate: true });

    const res = await request(app)
      .get('/api/vehicle/my-vehicle')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.driverId.isPrivate).toBe(true);
  });

  it('reports a public driver as false rather than omitting the field', async () => {
    // The app treats a missing flag as public, so an omitted field and false
    // agree — but only sending it when true would leave the app unable to tell
    // "public" from "this build does not send it".
    const { token } = await makeDriverWithVehicle({ isPrivate: false });

    const res = await request(app)
      .get('/api/vehicle/my-vehicle')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.driverId.isPrivate).toBe(false);
  });

  it('populates the driver without their credentials', async () => {
    const { token } = await makeDriverWithVehicle({ isPrivate: true });

    const res = await request(app)
      .get('/api/vehicle/my-vehicle')
      .set('Authorization', `Bearer ${token}`);

    // The projection widened to carry isPrivate; it must not have swept the
    // password or the enrollment key in with it.
    expect(res.body.data.driverId.password).toBeUndefined();
    expect(res.body.data.driverId.enrollmentKey).toBeUndefined();
  });

  it('404s when the driver has no vehicle', async () => {
    const driver = await Driver.create({
      name: 'MV Driver No Vehicle',
      email: `mv-drv-none-${stamp}@t.com`,
      password: 'P@ssw0rd!',
      managerId,
      isActive: true,
      isEmailVerified: true
    });
    const token = (await login(driver.email, 'P@ssw0rd!')).body.accessToken;

    const res = await request(app)
      .get('/api/vehicle/my-vehicle')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
