const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const Vehicle = require('../../src/models/Vehicle');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { resetAttempts } = require('../../src/controllers/enrollmentController');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, authHeader } = require('./factories');

// The rider-profile enrollment path (POST /api/enrollments/riders/:riderId).
//
// Distinct from driver-enrollment.test.js, which covers the account-scoped
// /redeem entry point. These two write different owner fields — /redeem sets
// the deprecated `userId`, this path sets `studentId` — and the read side has
// to find both. A suite that only exercises /redeem stays green while every
// enrollment made by the current app is invisible in "my shuttle", which is
// exactly the state this file was added to prevent recurring.

let managerId;
let managerToken;
let passengerToken;
let riderId;

const asManager = () => authHeader(managerToken);
const asPassenger = () => authHeader(passengerToken);

const stamp = Date.now();
let seq = 0;

async function makeDriverWithVehicle({ isPrivate = false, name = 'Rider-path Driver' } = {}) {
  seq += 1;
  const driver = await Driver.create({
    name,
    driverCode: `DRV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    password: 'P@ssw0rd!',
    managerId,
    isPrivate,
    isActive: true,
    isEmailVerified: true,
    phoneNumber: '0771234567'
  });
  const key = await ensureDriverEnrollmentKey(driver._id);
  const vehicle = await Vehicle.create({
    vehicleId: `RP-V-${stamp}-${seq}`,
    vehicleName: `Shuttle ${seq}`,
    registrationNumber: `RP-REG-${stamp}-${seq}`,
    numberPlate: `CBF-${3000 + seq}`,
    driverId: driver._id,
    managerId,
    routeId: ''
  });
  return { driver, key, vehicle };
}

const enrolRider = (key) =>
  request(app)
    .post(`/api/enrollments/riders/${riderId}`)
    .set(...asPassenger())
    .send({ key, schemaVersion: 1, responses: {} });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Rider-path Manager' });
  managerId = manager.id;
  managerToken = manager.token;

  const passenger = await createRider({ name: 'Rider-path Passenger' });
  passengerToken = passenger.token;

  // The account's own rider profile, created the way the app creates one.
  const created = await request(app)
    .post('/api/riders')
    .set(...asPassenger())
    .send({ fullName: 'Amaya', contactPhone: '0777654321' });
  riderId = created.body.data._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await DriverEnrollment.deleteMany({});
  resetAttempts();
});

describe('enrolling a rider profile', () => {
  test('the enrolment it writes is the one "my shuttle" reads back', async () => {
    const { driver, vehicle } = await makeDriverWithVehicle({ isPrivate: false });
    const { key } = { key: await ensureDriverEnrollmentKey(driver._id) };

    const enrolled = await enrolRider(key);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.data.status).toBe('ACTIVE');

    const stored = await DriverEnrollment.findOne({ driverId: driver._id });
    expect(String(stored.studentId)).toBe(String(riderId));

    // The regression: this read used to query `userId`, which createEnrollment
    // sets to null, so the list came back empty.
    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].driver.name).toBe('Rider-path Driver');
    expect(mine.body.data[0].driver.vehicle.vehicleId).toBe(vehicle.vehicleId);
  });

  test('a private driver queues the request and the manager can approve it', async () => {
    const { driver, key } = await makeDriverWithVehicle({ isPrivate: true, name: 'Private Driver' });

    const enrolled = await enrolRider(key);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.data.status).toBe('PENDING');

    const queue = await request(app).get('/api/manager/enrollment-requests').set(...asManager());
    expect(queue.status).toBe(200);
    const pending = queue.body.data.find((item) => String(item.driver?._id) === String(driver._id));
    expect(pending).toBeTruthy();

    // Approving calls enrollment.save(), which validates the whole document —
    // a row written without studentId cannot get past this point.
    const approved = await request(app)
      .post(`/api/manager/enrollment-requests/${pending._id}/approve`)
      .set(...asManager());
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('ACTIVE');

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].status).toBe('ACTIVE');
  });

  test('leaving removes an enrolment owned through the rider profile', async () => {
    const { driver } = await makeDriverWithVehicle({ isPrivate: false });
    const key = await ensureDriverEnrollmentKey(driver._id);

    const enrolled = await enrolRider(key);
    const enrollmentId = enrolled.body.data._id;

    const left = await request(app)
      .delete(`/api/enrollments/${enrollmentId}`)
      .set(...asPassenger());
    expect(left.status).toBe(200);

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mine.body.data).toHaveLength(0);
  });

  test("another account cannot leave someone else's enrolment", async () => {
    const { driver } = await makeDriverWithVehicle({ isPrivate: false });
    const key = await ensureDriverEnrollmentKey(driver._id);
    const enrolled = await enrolRider(key);

    const stranger = await createRider({ name: 'Stranger' });
    const left = await request(app)
      .delete(`/api/enrollments/${enrolled.body.data._id}`)
      .set(...authHeader(stranger.token));

    expect(left.status).toBe(404);
    expect(await DriverEnrollment.countDocuments({})).toBe(1);
  });
});

describe('multiple rider profiles on one account', () => {
  // Regression: GET /mine used to merge every rider profile's enrolments into
  // one list regardless of ?riderId, so enrolling or leaving as one rider
  // profile appeared to affect a sibling profile on the same account too.
  test('each rider profile only sees, and only loses, its own enrolment', async () => {
    const { driver: driverA } = await makeDriverWithVehicle({ isPrivate: false, name: 'Sibling Driver A' });
    const { driver: driverB } = await makeDriverWithVehicle({ isPrivate: false, name: 'Sibling Driver B' });
    const keyA = await ensureDriverEnrollmentKey(driverA._id);
    const keyB = await ensureDriverEnrollmentKey(driverB._id);

    const secondRider = await request(app)
      .post('/api/riders')
      .set(...asPassenger())
      .send({ fullName: 'Kavi', contactPhone: '0779998887' });
    const secondRiderId = secondRider.body.data._id;

    const enrolledFirst = await enrolRider(keyA);
    expect(enrolledFirst.status).toBe(201);
    const enrolledSecond = await request(app)
      .post(`/api/enrollments/riders/${secondRiderId}`)
      .set(...asPassenger())
      .send({ key: keyB, schemaVersion: 1, responses: {} });
    expect(enrolledSecond.status).toBe(201);

    const mineFirst = await request(app)
      .get('/api/enrollments/mine')
      .query({ riderId })
      .set(...asPassenger());
    expect(mineFirst.body.data).toHaveLength(1);
    expect(mineFirst.body.data[0].driver.name).toBe('Sibling Driver A');

    const mineSecond = await request(app)
      .get('/api/enrollments/mine')
      .query({ riderId: secondRiderId })
      .set(...asPassenger());
    expect(mineSecond.body.data).toHaveLength(1);
    expect(mineSecond.body.data[0].driver.name).toBe('Sibling Driver B');

    // No riderId keeps the old full-merge behaviour for back-compat.
    const mineAll = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mineAll.body.data).toHaveLength(2);

    // Leaving the first rider's enrolment must not touch the second rider's.
    await request(app)
      .delete(`/api/enrollments/${enrolledFirst.body.data._id}`)
      .set(...asPassenger())
      .expect(200);

    const mineSecondAfter = await request(app)
      .get('/api/enrollments/mine')
      .query({ riderId: secondRiderId })
      .set(...asPassenger());
    expect(mineSecondAfter.body.data).toHaveLength(1);
    expect(mineSecondAfter.body.data[0].driver.name).toBe('Sibling Driver B');
  });
});
