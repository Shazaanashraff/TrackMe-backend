const request = require('supertest');
const app = require('../../src/server');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createDriver } = require('./factories');

// GET /api/vehicle/my-vehicle. The driver app reads the owning driver off this
// payload to show whether enrolment with their key needs the manager's approval,
// so the populated driver has to carry isPrivate and nothing more than it needs.

let managerId;

const stamp = Date.now();
let seq = 0;

async function makeDriverWithVehicle({ isPrivate }) {
  const n = seq++;
  const { doc: driver, token } = await createDriver({
    name: `MV Driver ${n}`,
    fields: { managerId, isPrivate }
  });

  await Vehicle.create({
    vehicleId: `MV-V-${stamp}-${n}`,
    vehicleName: `Shuttle ${n}`,
    registrationNumber: `MV-REG-${stamp}-${n}`,
    numberPlate: `CAB-${1000 + n}`,
    driverId: driver._id,
    managerId
  });

  return { driver, token };
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  // Only referenced as a managerId foreign key below, so it never signs in.
  ({ id: managerId } = await createManager({ name: 'My Vehicle Manager', signIn: false }));
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
    const { token } = await createDriver({
      name: 'MV Driver No Vehicle',
      fields: { managerId }
    });

    const res = await request(app)
      .get('/api/vehicle/my-vehicle')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
