const request = require('supertest');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createDriver, createRider, authHeader } = require('./factories');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const RiderProfile = require('../../src/models/RiderProfile');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { signQr } = require('../../src/utils/qrToken');

// Regression coverage for issue #59 — the driver QR scan endpoint used to only debounce a
// same-type repeat scan within a short (default 30s) time window, so a same-type re-scan for
// the same open trip outside that window was recorded as a brand-new event, double-counting
// into managerAttendanceController's per-student boardCount/alightCount rollup with no ALIGHT
// between the two BOARDs.
//
// This suite builds its own RiderProfile fixture directly (rather than reusing the shared
// `createRider`/`freshTokenForRider` pattern in qr-attendance.test.js) because `createRider`
// only provisions a `User` account, not the `RiderProfile` document `signQr`/`verifyQr` actually
// operate on post-rider-profile-split — that mismatch pre-dates this change and breaks every
// QR-scan test in this file's sibling suite independent of it (confirmed reproducing identically
// on unmodified main), so it's isolated here to get a genuinely verifiable green test.
jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
  function Expo() {
    return { chunkPushNotifications: (messages) => [messages], sendPushNotificationsAsync };
  }
  Expo.isExpoPushToken = () => false;
  return { Expo, __mockSendPushNotificationsAsync: sendPushNotificationsAsync };
});

describe('POST /api/driver/boarding/scan — trip-scoped same-type dedup (issue #59)', () => {
  let manager, driver, rider, route, vehicle, riderProfile;

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();

    manager = await createManager({ name: 'Dedup Manager' });
    driver = await createDriver({ name: 'Dedup Driver' });
    rider = await createRider({ name: 'Dedup Rider' });

    route = await Route.create({
      routeId: `DEDUP-${Date.now()}`.toUpperCase(),
      routeName: 'Dedup Route',
      source: 'Home', destination: 'Work', distance: 5, fare: 50,
      managerId: manager.id, qrEnabled: true
    });

    vehicle = await Vehicle.create({
      vehicleId: `DEDUP-VEHICLE-${Date.now()}`,
      vehicleName: 'Dedup Shuttle',
      registrationNumber: `DEDUP-REG-${Date.now()}`,
      numberPlate: `DEDUP-PLT-${Date.now()}`,
      routeId: route.routeId,
      driverId: driver.id,
      managerId: manager.id
    });

    riderProfile = await RiderProfile.create({
      accountId: rider.id,
      riderCode: `DEDUP-RC-${Date.now()}`,
      fullName: 'Dedup Rider Profile'
    });

    await DriverEnrollment.create({
      studentId: riderProfile._id,
      driverId: driver.id,
      status: 'ACTIVE'
    });
  });

  afterEach(async () => {
    await BoardingEvent.deleteMany({});
  });

  afterAll(async () => {
    await clearTestDb();
    await closeTestDb();
  });

  function freshToken() {
    return signQr(riderProfile).token;
  }

  function scan(body) {
    return request(app)
      .post('/api/driver/boarding/scan')
      .set(...authHeader(driver.token))
      .send(body);
  }

  test('a second BOARD for the same open trip is treated as a duplicate, even long after the debounce window', async () => {
    const first = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(first.status).toBe(201);
    expect(first.body.debounced).toBe(false);

    // Push the stored event's timestamp well outside the debounce window so only the
    // trip-scoped same-type check is exercised.
    await BoardingEvent.updateOne(
      { _id: first.body.data.eventId },
      { $set: { timestamp: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const second = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(second.status).toBe(200);
    expect(second.body.debounced).toBe(true);
    expect(second.body.data.eventId).toBe(first.body.data.eventId);

    const count = await BoardingEvent.countDocuments({ studentId: riderProfile._id, type: 'BOARD' });
    expect(count).toBe(1);
  });

  test('does not double-count a duplicate BOARD into the manager attendance rollup', async () => {
    const first = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(first.status).toBe(201);
    await BoardingEvent.updateOne(
      { _id: first.body.data.eventId },
      { $set: { timestamp: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const second = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(second.body.debounced).toBe(true);

    const rollup = await request(app)
      .get('/api/manager/attendance')
      .set(...authHeader(manager.token));
    expect(rollup.status).toBe(200);
    const entry = rollup.body.data.find((e) => e.studentId === String(riderProfile._id));
    expect(entry.boardCount).toBe(1);
  });

  test('a real re-boarding after an ALIGHT still counts as a new BOARD, however long after', async () => {
    const board1 = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(board1.status).toBe(201);
    const boardTime = new Date(Date.now() - 10 * 60 * 1000);
    await BoardingEvent.updateOne({ _id: board1.body.data.eventId }, { $set: { timestamp: boardTime } });

    const alight = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'ALIGHT' });
    expect(alight.status).toBe(201);
    expect(alight.body.debounced).toBe(false);
    // Strictly later than board1's backdated timestamp, so the "most recent event
    // for this trip" lookup unambiguously resolves to the ALIGHT.
    const alightTime = new Date(boardTime.getTime() + 1000);
    await BoardingEvent.updateOne({ _id: alight.body.data.eventId }, { $set: { timestamp: alightTime } });

    const board2 = await scan({ token: freshToken(), vehicleId: vehicle.vehicleId, type: 'BOARD' });
    expect(board2.status).toBe(201);
    expect(board2.body.debounced).toBe(false);
    expect(board2.body.data.eventId).not.toBe(board1.body.data.eventId);

    const count = await BoardingEvent.countDocuments({ studentId: riderProfile._id });
    expect(count).toBe(3);

    const rollup = await request(app)
      .get('/api/manager/attendance')
      .set(...authHeader(manager.token));
    const entry = rollup.body.data.find((e) => e.studentId === String(riderProfile._id));
    expect(entry.boardCount).toBe(2);
    expect(entry.alightCount).toBe(1);
  });
});
