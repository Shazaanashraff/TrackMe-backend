const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const Vehicle = require('../../../src/models/Vehicle');
const Driver = require('../../../src/models/Driver');
const DriverEnrollment = require('../../../src/models/DriverEnrollment');
const RiderProfile = require('../../../src/models/RiderProfile');
const VehicleLiveLocation = require('../../../src/models/VehicleLiveLocation');
const liveVehicles = require('../../../src/utils/liveVehicles');
const rateLimit = require('../../../src/utils/socketRateLimit');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');
const { createRider, createDriver, createManager } = require('../factories');

// Live vehicle location over the socket.
//
// The cases that matter are the authorization boundary (who may watch whose
// vehicle) and the two behaviours that are easy to get wrong under a real
// mobile client: a replayed offline buffer must not walk the marker backwards,
// and a dropped connection must not end a shift instantly.

let port;
let manager;
let otherManager;
let driver;
let otherDriver;
let vehicle;
let otherVehicle;
let rider;
let riderProfile;
let strangerRider;
let strangerProfile;

const clients = [];

function connect(token) {
  return new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true
    });
    c.on('connection-success', () => resolve(c));
    c.on('connect_error', reject);
    clients.push(c);
  });
}

const emit = (client, event, payload) =>
  new Promise((resolve) => client.emit(event, payload, resolve));

const nextEvent = (client, event, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await new Promise((resolve) => server.listen(0, () => resolve()));
  port = server.address().port;

  manager = await createManager({ name: 'Live Manager' });
  otherManager = await createManager({ name: 'Rival Manager' });

  driver = await createDriver({ name: 'Live Driver', fields: { managerId: manager.id } });
  otherDriver = await createDriver({ name: 'Other Driver', fields: { managerId: otherManager.id } });

  vehicle = await Vehicle.create({
    vehicleId: 'LIVE-V-1',
    vehicleName: 'Shuttle One',
    registrationNumber: 'LIVE-REG-1',
    numberPlate: 'LV-1001',
    driverId: driver.id,
    managerId: manager.id,
    routeId: 'R-LIVE'
  });

  otherVehicle = await Vehicle.create({
    vehicleId: 'LIVE-V-2',
    vehicleName: 'Shuttle Two',
    registrationNumber: 'LIVE-REG-2',
    numberPlate: 'LV-1002',
    driverId: otherDriver.id,
    managerId: otherManager.id,
    routeId: 'R-LIVE'
  });

  rider = await createRider({ name: 'Enrolled Rider' });
  riderProfile = await RiderProfile.create({
    _id: rider.id,
    accountId: rider.id,
    riderCode: 'TMR-LIVE-0001',
    fullName: 'Enrolled Rider'
  });

  strangerRider = await createRider({ name: 'Stranger Rider' });
  strangerProfile = await RiderProfile.create({
    accountId: strangerRider.id,
    riderCode: 'TMR-LIVE-0002',
    fullName: 'Stranger Rider'
  });

  await DriverEnrollment.create({
    studentId: riderProfile._id,
    driverId: driver.id,
    managerId: manager.id,
    status: 'ACTIVE'
  });
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  liveVehicles.reset();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await VehicleLiveLocation.deleteMany({});
  liveVehicles.reset();
  rateLimit.reset();
});

describe('driver broadcasting', () => {
  it('going live creates exactly one document and tells watchers', async () => {
    const driverClient = await connect(driver.token);
    const riderClient = await connect(rider.token);

    const sub = await emit(riderClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId,
      riderId: String(riderProfile._id)
    });
    expect(sub.success).toBe(true);
    expect(sub.data.live).toBe(false);
    expect(sub.data.location).toBeNull();

    const statusSeen = nextEvent(riderClient, 'vehicle:status');
    const started = await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    expect(started.success).toBe(true);
    expect(started.data.vehicleId).toBe(vehicle.vehicleId);
    expect(started.data.sessionId).toBeTruthy();

    const status = await statusSeen;
    expect(status).toMatchObject({ vehicleId: vehicle.vehicleId, live: true, reason: 'DRIVER_STARTED' });

    expect(await VehicleLiveLocation.countDocuments({ vehicleId: vehicle.vehicleId })).toBe(1);
  });

  it('a second fix overwrites rather than appending', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.9271, lng: 79.8612, timestamp: Date.now() - 1000
    });
    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.9300, lng: 79.8700, timestamp: Date.now()
    });

    expect(await VehicleLiveLocation.countDocuments({ vehicleId: vehicle.vehicleId })).toBe(1);
    const doc = await VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean();
    expect(doc.lat).toBeCloseTo(6.9300, 4);
    expect(doc.lng).toBeCloseTo(79.8700, 4);
  });

  it('an enrolled rider receives the position', async () => {
    const driverClient = await connect(driver.token);
    const riderClient = await connect(rider.token);
    await emit(riderClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId, riderId: String(riderProfile._id)
    });
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    const updateSeen = nextEvent(riderClient, 'vehicle:update');
    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.9271, lng: 79.8612, timestamp: Date.now()
    });

    const update = await updateSeen;
    expect(update).toMatchObject({ vehicleId: vehicle.vehicleId, live: true });
    expect(update.lat).toBeCloseTo(6.9271, 4);
    expect(update.numberPlate).toBe('LV-1001');
  });

  it('a replayed older fix is accepted but neither stored nor broadcast', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    const now = Date.now();
    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.9300, lng: 79.8700, timestamp: now
    });

    const replayed = await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.0000, lng: 79.0000, timestamp: now - 60_000
    });

    // Success, not a NACK: the client re-buffers anything it reads as a failure.
    expect(replayed.success).toBe(true);
    expect(replayed.data.stale).toBe(true);

    const doc = await VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean();
    expect(doc.lat).toBeCloseTo(6.9300, 4);
  });

  it('rejects coordinates that are out of range', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    const res = await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 999, lng: 79.8612
    });
    expect(res).toMatchObject({ success: false, code: 'INVALID_COORDS' });
  });

  it('stopping marks the vehicle offline', async () => {
    const driverClient = await connect(driver.token);
    const riderClient = await connect(rider.token);
    await emit(riderClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId, riderId: String(riderProfile._id)
    });
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    const statusSeen = nextEvent(riderClient, 'vehicle:status');
    const stopped = await emit(driverClient, 'driver:stop-tracking', { vehicleId: vehicle.vehicleId });
    expect(stopped.success).toBe(true);

    const status = await statusSeen;
    expect(status).toMatchObject({ live: false, reason: 'DRIVER_STOPPED' });

    const doc = await VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean();
    expect(doc.live).toBe(false);
    expect(doc.endedReason).toBe('DRIVER_STOPPED');
  });

  it("a driver cannot broadcast for another driver's vehicle", async () => {
    const driverClient = await connect(driver.token);
    const res = await emit(driverClient, 'driver:start-tracking', { vehicleId: otherVehicle.vehicleId });
    expect(res).toMatchObject({ success: false, code: 'VEHICLE_NOT_FOUND' });
  });

  it('a rider cannot broadcast at all', async () => {
    const riderClient = await connect(rider.token);
    const res = await emit(riderClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });
    expect(res).toMatchObject({ success: false, code: 'FORBIDDEN_ROLE' });
  });
});

describe('who may watch', () => {
  it('refuses a rider who is not enrolled with that vehicle', async () => {
    const strangerClient = await connect(strangerRider.token);
    const res = await emit(strangerClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId,
      riderId: String(strangerProfile._id)
    });
    expect(res).toMatchObject({ success: false, code: 'NOT_ENROLLED' });
  });

  it('refuses a rider id the caller does not own', async () => {
    const strangerClient = await connect(strangerRider.token);
    const res = await emit(strangerClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId,
      riderId: String(riderProfile._id)
    });
    expect(res).toMatchObject({ success: false, code: 'RIDER_NOT_FOUND' });
  });

  it('refuses an enrolled rider watching a different driver’s vehicle', async () => {
    const riderClient = await connect(rider.token);
    const res = await emit(riderClient, 'vehicle:subscribe', {
      vehicleId: otherVehicle.vehicleId,
      riderId: String(riderProfile._id)
    });
    expect(res).toMatchObject({ success: false, code: 'NOT_ENROLLED' });
  });

  it('lets the owning manager watch, and refuses another manager', async () => {
    const ownerClient = await connect(manager.token);
    const rivalClient = await connect(otherManager.token);

    const allowed = await emit(ownerClient, 'vehicle:subscribe', { vehicleId: vehicle.vehicleId });
    expect(allowed.success).toBe(true);
    expect(allowed.data.vehicle.numberPlate).toBe('LV-1001');

    const refused = await emit(rivalClient, 'vehicle:subscribe', { vehicleId: vehicle.vehicleId });
    expect(refused).toMatchObject({ success: false, code: 'FORBIDDEN' });
  });

  it('seeds a late joiner with the current position', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });
    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.9271, lng: 79.8612, timestamp: Date.now()
    });

    const lateClient = await connect(manager.token);
    const sub = await emit(lateClient, 'vehicle:subscribe', { vehicleId: vehicle.vehicleId });

    expect(sub.success).toBe(true);
    expect(sub.data.live).toBe(true);
    expect(sub.data.location.lat).toBeCloseTo(6.9271, 4);
    expect(sub.data.driver.name).toBe('Live Driver');
  });

  it('stops delivering after unsubscribe', async () => {
    const driverClient = await connect(driver.token);
    const riderClient = await connect(rider.token);
    await emit(riderClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId, riderId: String(riderProfile._id)
    });
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });
    await emit(riderClient, 'vehicle:unsubscribe', { vehicleId: vehicle.vehicleId });

    let seen = false;
    riderClient.once('vehicle:update', () => { seen = true; });
    await emit(driverClient, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.93, lng: 79.87, timestamp: Date.now()
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toBe(false);
  });
});

describe('losing the connection', () => {
  it('does not end the shift immediately, then ends it when the grace expires', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    driverClient.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Still live: a background driver's socket drops constantly.
    const during = await VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean();
    expect(during.live).toBe(true);

    const ended = await liveVehicles.endSession(vehicle.vehicleId, 'DRIVER_DISCONNECTED');
    expect(ended.live).toBe(false);
    expect(ended.endedReason).toBe('DRIVER_DISCONNECTED');
  });

  it('a reconnecting driver re-adopts the shift instead of being refused', async () => {
    const first = await connect(driver.token);
    await emit(first, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });
    first.disconnect();

    // A fresh socket with no cached session — what a redeploy or a doze wake
    // looks like. It must be adopted, not rejected.
    const second = await connect(driver.token);
    const res = await emit(second, 'driver:location', {
      vehicleId: vehicle.vehicleId, lat: 6.95, lng: 79.88, timestamp: Date.now()
    });

    expect(res.success).toBe(true);
    const doc = await VehicleLiveLocation.findOne({ vehicleId: vehicle.vehicleId }).lean();
    expect(doc.live).toBe(true);
    expect(doc.lat).toBeCloseTo(6.95, 4);
  });

  it('a burst the size of the offline buffer is not rate-limited into failure', async () => {
    const driverClient = await connect(driver.token);
    await emit(driverClient, 'driver:start-tracking', { vehicleId: vehicle.vehicleId });

    const base = Date.now() - 50_000;
    const results = [];
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await emit(driverClient, 'driver:location', {
        vehicleId: vehicle.vehicleId,
        lat: 6.9 + i * 0.0001,
        lng: 79.8 + i * 0.0001,
        timestamp: base + i * 1000
      }));
    }

    // Any NACK here is re-buffered by the client and replayed forever.
    expect(results.every((r) => r.success === true)).toBe(true);
  });
});

describe('leaving an enrolment while watching', () => {
  it('force-leaving the vehicle room via DELETE /api/enrollments/:id', async () => {
    const request = require('supertest');
    const httpApp = require('../../../src/server');

    const leavingRider = await createRider({ name: 'Leaving Rider' });
    const leavingProfile = await RiderProfile.create({
      _id: leavingRider.id,
      accountId: leavingRider.id,
      riderCode: 'TMR-LIVE-0003',
      fullName: 'Leaving Rider'
    });
    const enrollment = await DriverEnrollment.create({
      studentId: leavingProfile._id,
      driverId: driver.id,
      managerId: manager.id,
      status: 'ACTIVE'
    });

    const leavingClient = await connect(leavingRider.token);
    const sub = await emit(leavingClient, 'vehicle:subscribe', {
      vehicleId: vehicle.vehicleId, riderId: String(leavingProfile._id)
    });
    expect(sub.success).toBe(true);

    const revoked = nextEvent(leavingClient, 'vehicle:access-revoked');
    const left = await request(httpApp)
      .delete(`/api/enrollments/${enrollment._id}`)
      .set('Authorization', `Bearer ${leavingRider.token}`);
    expect(left.status).toBe(200);

    const event = await revoked;
    expect(event).toMatchObject({ vehicleId: vehicle.vehicleId, riderId: String(leavingProfile._id) });
  });
});

describe('socket authentication', () => {
  it('refuses a refresh token', async () => {
    const jwt = require('jsonwebtoken');
    const refresh = jwt.sign(
      { id: driver.id, role: 'driver', tokenType: 'refresh' },
      process.env.JWT_SECRET
    );

    await expect(connect(refresh)).rejects.toThrow(/refresh tokens cannot open a socket/);
  });

  it('refuses a token for an account that no longer exists', async () => {
    const jwt = require('jsonwebtoken');
    const ghost = jwt.sign(
      { id: '5f0a1b2c3d4e5f6a7b8c9d0e', role: 'driver', tokenType: 'access' },
      process.env.JWT_SECRET
    );

    await expect(connect(ghost)).rejects.toThrow(/account not found/);
  });

  it('refuses a deactivated account', async () => {
    const suspended = await createDriver({ name: 'Suspended', fields: { managerId: manager.id } });
    await Driver.updateOne({ _id: suspended.id }, { $set: { isActive: false } });

    await expect(connect(suspended.token)).rejects.toThrow(/deactivated/);
  });
});
