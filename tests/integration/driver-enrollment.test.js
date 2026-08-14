const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const Vehicle = require('../../src/models/Vehicle');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { resetAttempts } = require('../../src/controllers/enrollmentController');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, authHeader } = require('./factories');

// Redeeming a driver's enrollment key. A public driver enrols the passenger on
// the spot; a private one only raises a request that the owning manager decides.
// The cases that matter are the gate itself and who is allowed to lift it.

let managerToken;
let otherManagerToken;
let passengerToken;
let managerId;
let otherManagerId;
let passengerId;

const asManager = () => authHeader(managerToken);
const asOtherManager = () => authHeader(otherManagerToken);
const asPassenger = () => authHeader(passengerToken);

const stamp = Date.now();

async function makeDriver({ isPrivate = false, manager = managerId, name = 'Driver' } = {}) {
  const driver = await Driver.create({
    name,
    driverCode: `DRV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    password: 'P@ssw0rd!',
    managerId: manager,
    isPrivate,
    isActive: true,
    isEmailVerified: true
  });
  const key = await ensureDriverEnrollmentKey(driver._id);
  return { driver, key };
}

let vehicleSeq = 0;

async function makeVehicleFor(driver, { routeId = '' } = {}) {
  vehicleSeq += 1;
  return Vehicle.create({
    vehicleId: `ENR-V-${stamp}-${vehicleSeq}`,
    vehicleName: `Shuttle ${vehicleSeq}`,
    registrationNumber: `ENR-REG-${stamp}-${vehicleSeq}`,
    numberPlate: `CBE-${2000 + vehicleSeq}`,
    driverId: driver._id,
    managerId,
    routeId
  });
}

const redeem = (key) => request(app).post('/api/enrollments/redeem').set(...asPassenger()).send({ key });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Enrolment Manager' });
  managerId = manager.id;
  managerToken = manager.token;

  const other = await createManager({ name: 'Other Manager' });
  otherManagerId = other.id;
  otherManagerToken = other.token;

  const passenger = await createRider({ name: 'Enrolment Rider' });
  passengerId = passenger.id;
  passengerToken = passenger.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await DriverEnrollment.deleteMany({});
  resetAttempts();
});

describe('redeeming a public driver key', () => {
  test('enrols the passenger immediately', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false, name: 'Public Driver' });

    const res = await redeem(key);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.driver.name).toBe('Public Driver');

    const stored = await DriverEnrollment.findOne({ userId: passengerId, driverId: driver._id });
    expect(stored.status).toBe('ACTIVE');
    expect(stored.requiredApproval).toBe(false);
  });

  test('a second redeem reports the existing enrolment rather than duplicating it', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false });

    await redeem(key);
    const res = await redeem(key);

    expect(res.status).toBe(409);
    expect(await DriverEnrollment.countDocuments({ driverId: driver._id })).toBe(1);
  });
});

describe('redeeming a private driver key', () => {
  test('raises a request instead of enrolling', async () => {
    const { driver, key } = await makeDriver({ isPrivate: true, name: 'Private Driver' });

    const res = await redeem(key);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');

    const stored = await DriverEnrollment.findOne({ userId: passengerId, driverId: driver._id });
    expect(stored.status).toBe('PENDING');
    expect(stored.requiredApproval).toBe(true);
  });

  test('redeeming again while queued is idempotent', async () => {
    const { driver, key } = await makeDriver({ isPrivate: true });

    await redeem(key);
    const res = await redeem(key);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING');
    expect(await DriverEnrollment.countDocuments({ driverId: driver._id })).toBe(1);
  });

  test('the manager sees it queued and approving turns it into an enrolment', async () => {
    const { key } = await makeDriver({ isPrivate: true });
    const requestId = (await redeem(key)).body.data._id;

    const queue = await request(app).get('/api/manager/enrollment-requests').set(...asManager());
    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].passenger.name).toBe('Enrolment Rider');

    const count = await request(app)
      .get('/api/manager/enrollment-requests/count')
      .set(...asManager());
    expect(count.body.data.count).toBe(1);

    const approved = await request(app)
      .post(`/api/manager/enrollment-requests/${requestId}/approve`)
      .set(...asManager());
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('ACTIVE');

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mine.body.data[0].status).toBe('ACTIVE');
  });

  test('rejecting leaves the passenger unenrolled but able to ask again', async () => {
    const { driver, key } = await makeDriver({ isPrivate: true });
    const requestId = (await redeem(key)).body.data._id;

    await request(app)
      .post(`/api/manager/enrollment-requests/${requestId}/reject`)
      .set(...asManager())
      .expect(200);

    expect((await DriverEnrollment.findById(requestId)).status).toBe('REJECTED');

    // Rejected requests are hidden from the passenger's own list.
    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger());
    expect(mine.body.data).toHaveLength(0);

    const retry = await redeem(key);
    expect(retry.status).toBe(201);
    expect(retry.body.data.status).toBe('PENDING');
    expect(await DriverEnrollment.countDocuments({ driverId: driver._id })).toBe(1);
  });

  test('a decision cannot be made twice', async () => {
    const { key } = await makeDriver({ isPrivate: true });
    const requestId = (await redeem(key)).body.data._id;

    await request(app)
      .post(`/api/manager/enrollment-requests/${requestId}/approve`)
      .set(...asManager())
      .expect(200);

    const again = await request(app)
      .post(`/api/manager/enrollment-requests/${requestId}/reject`)
      .set(...asManager());
    expect(again.status).toBe(409);
  });
});

describe('ownership', () => {
  test('a manager cannot decide a request against another manager\'s driver', async () => {
    const { key } = await makeDriver({ isPrivate: true, manager: managerId });
    const requestId = (await redeem(key)).body.data._id;

    const res = await request(app)
      .post(`/api/manager/enrollment-requests/${requestId}/approve`)
      .set(...asOtherManager());

    expect(res.status).toBe(404);
    expect((await DriverEnrollment.findById(requestId)).status).toBe('PENDING');
  });

  test('the queue only lists requests for drivers the manager owns', async () => {
    const { key } = await makeDriver({ isPrivate: true, manager: otherManagerId });
    await redeem(key);

    const mine = await request(app).get('/api/manager/enrollment-requests').set(...asManager());
    expect(mine.body.data).toHaveLength(0);

    const theirs = await request(app).get('/api/manager/enrollment-requests').set(...asOtherManager());
    expect(theirs.body.data).toHaveLength(1);
  });
});

describe('bad keys', () => {
  test('an unknown key gives a generic failure', async () => {
    const res = await redeem('TMD-ZZZZ-ZZZZ-ZZZZ');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('That enrollment key is not valid');
  });

  test('an inactive driver is indistinguishable from an unknown key', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false });
    driver.isActive = false;
    await driver.save();

    const res = await redeem(key);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('That enrollment key is not valid');
  });

  test('an empty key is rejected before any lookup', async () => {
    const res = await redeem('   ');
    expect(res.status).toBe(400);
  });

  test('repeated wrong keys are throttled', async () => {
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await redeem('TMD-ZZZZ-ZZZZ-ZZZZ');
    }
    const res = await redeem('TMD-ZZZZ-ZZZZ-ZZZZ');
    expect(res.status).toBe(429);
  });

  test('a good key clears earlier failures', async () => {
    const { key } = await makeDriver({ isPrivate: false });
    await redeem('TMD-ZZZZ-ZZZZ-ZZZZ');
    await redeem('TMD-ZZZZ-ZZZZ-ZZZZ');

    expect((await redeem(key)).status).toBe(201);
  });
});

describe('the driver summary a passenger receives', () => {
  // An enrolment is keyed to a driver, so the vehicle's routeId is the only thing that
  // ties it back to a route. The passenger app needs it to decide whether the route it
  // is showing is one this passenger may track.
  test('carries the route the driver runs, on redeem and in the list', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false, name: 'Routed Driver' });
    await makeVehicleFor(driver, { routeId: 'SCH-ROUTED' });

    const redeemed = await redeem(key);
    expect(redeemed.status).toBe(201);
    expect(redeemed.body.data.driver.vehicle).toMatchObject({ routeId: 'SCH-ROUTED' });

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger()).expect(200);
    expect(mine.body.data[0].driver.vehicle).toMatchObject({ routeId: 'SCH-ROUTED' });
  });

  test('includes vehicle details and an available driver email for an active enrolment', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false, name: 'Contact Driver' });
    const email = `contact-driver-${stamp}@test.com`;
    await Driver.findByIdAndUpdate(driver._id, { $set: { email } });
    const vehicle = await makeVehicleFor(driver);

    const redeemed = await redeem(key);
    expect(redeemed.body.data.driver.email).toBe(email);
    expect(redeemed.body.data.driver.vehicle).toMatchObject({
      vehicleName: vehicle.vehicleName,
      numberPlate: vehicle.numberPlate,
      vehicleId: vehicle.vehicleId,
      vehicleType: vehicle.vehicleType,
      serviceType: vehicle.serviceType
    });

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger()).expect(200);
    expect(mine.body.data[0].driver.email).toBe(email);
    expect(mine.body.data[0].driver.vehicle.vehicleName).toBe(vehicle.vehicleName);
  });

  test('reports a null routeId when the driver has a vehicle but no route assigned', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false, name: 'Routeless Driver' });
    await makeVehicleFor(driver, { routeId: '' });

    const redeemed = await redeem(key);

    expect(redeemed.body.data.driver.vehicle.routeId).toBeNull();
  });

  test('gives an approved passenger the driver phone number', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false, name: 'Public Driver' });
    await Driver.findByIdAndUpdate(driver._id, { $set: { phoneNumber: '0771234567' } });

    const redeemed = await redeem(key);
    expect(redeemed.body.data.driver.phoneNumber).toBe('0771234567');

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger()).expect(200);
    expect(mine.body.data[0].driver.phoneNumber).toBe('0771234567');
  });

  // Redeeming a private driver's key only raises a request. Until the manager approves
  // it, submitting the key must not by itself hand out the driver's personal number.
  test('withholds the phone number while the request is still pending', async () => {
    const { driver, key } = await makeDriver({ isPrivate: true, name: 'Private Driver' });
    await Driver.findByIdAndUpdate(driver._id, {
      $set: { phoneNumber: '0777654321', email: `private-driver-${stamp}@test.com` }
    });

    const redeemed = await redeem(key);
    expect(redeemed.body.data.status).toBe('PENDING');
    expect(redeemed.body.data.driver.phoneNumber).toBeNull();
    expect(redeemed.body.data.driver.email).toBeNull();

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger()).expect(200);
    expect(mine.body.data[0].status).toBe('PENDING');
    expect(mine.body.data[0].driver.phoneNumber).toBeNull();
    expect(mine.body.data[0].driver.email).toBeNull();
  });

  test('releases the phone number once the manager approves', async () => {
    const { driver, key } = await makeDriver({ isPrivate: true, name: 'Approved Driver' });
    await Driver.findByIdAndUpdate(driver._id, { $set: { phoneNumber: '0770000111' } });
    const id = (await redeem(key)).body.data._id;

    await request(app)
      .post(`/api/manager/enrollment-requests/${id}/approve`)
      .set(...asManager())
      .expect(200);

    const mine = await request(app).get('/api/enrollments/mine').set(...asPassenger()).expect(200);
    expect(mine.body.data[0].status).toBe('ACTIVE');
    expect(mine.body.data[0].driver.phoneNumber).toBe('0770000111');
  });
});

describe('leaving', () => {
  test('a passenger can drop an enrolment and enrol again later', async () => {
    const { driver, key } = await makeDriver({ isPrivate: false });
    const id = (await redeem(key)).body.data._id;

    await request(app).delete(`/api/enrollments/${id}`).set(...asPassenger()).expect(200);
    expect(await DriverEnrollment.countDocuments({ driverId: driver._id })).toBe(0);

    expect((await redeem(key)).status).toBe(201);
  });
});
