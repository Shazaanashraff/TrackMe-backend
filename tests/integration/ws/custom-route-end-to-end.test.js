const request = require('supertest');
const { io: ioClient } = require('socket.io-client');

jest.setTimeout(60000);

// The map matcher is an external service; it is replaced by one that treats the driven
// track as the road. Everything else - REST, auth, state changes, the socket, the
// database, notifications - runs for real.
jest.mock('../../../src/utils/mapMatch', () => {
  class MatchUnavailable extends Error {}
  return {
    MatchUnavailable,
    cleanTrace: (p) => p,
    matchRawTrace: jest.fn(async (points) => ({
      coords: points.map((p) => ({ lat: p.lat, lng: p.lng })),
      confidence: 0.9,
      provider: 'osrm',
      cleanedCount: points.length
    }))
  };
});

const { server } = require('../../../src/server');
const app = require('../../../src/server');
const Vehicle = require('../../../src/models/Vehicle');
const Route = require('../../../src/models/Route');
const DriverEnrollment = require('../../../src/models/DriverEnrollment');
const RiderProfile = require('../../../src/models/RiderProfile');
const HouseholdPlace = require('../../../src/models/HouseholdPlace');
const Notification = require('../../../src/models/Notification');
const VehicleLiveLocation = require('../../../src/models/VehicleLiveLocation');
const RouteRecordingRun = require('../../../src/models/RouteRecordingRun');
const Driver = require('../../../src/models/Driver');
const liveVehicles = require('../../../src/utils/liveVehicles');
const rateLimit = require('../../../src/utils/socketRateLimit');
const pushHelper = require('../../../src/utils/pushHelper');
const stopArrivals = require('../../../src/services/stopArrivalNotifier');
const { createProvisionalRoute } = require('../../../src/utils/customRoute');
const { decodePolyline } = require('../../../src/utils/roadSnap');
const geo = require('../../../src/utils/geo');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');
const { createManager, createDriver, createRider, authHeader } = require('../factories');

// The whole story, once, start to finish:
//   the driver records 5 rides and names the stops as they go -> the manager confirms ->
//   the parent sees the stops -> the shuttle drives the route -> the parent is told it has
//   arrived at their stop (and not at anyone else's).

const METERS = 111320;
const NORTH = (m) => 6.9 + m / METERS;
let port;
let manager;
let driver;
let parent;
let profile;
let route;
let vehicle;
let pushSpy;
const clients = [];

const connect = (token) => new Promise((resolve, reject) => {
  const c = ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
  c.on('connection-success', () => resolve(c));
  c.on('connect_error', reject);
  clients.push(c);
});
const emit = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve));
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await settle(40);
  }
  return false;
}

// One recorded ride: ~2.2 km north with the driver's "Add stop" taps (and names) on the way.
// `dLng` is the few metres of sideways wobble a different day's GPS has.
let rideSeq = 0;
const recordedRide = (dLng, stopNames) => ({
  clientRunId: `e2e-${Date.now()}-${rideSeq++}`,
  startedAt: new Date(1_700_000_000_000).toISOString(),
  endedAt: new Date(1_700_000_000_000 + 1_500_000).toISOString(),
  points: Array.from({ length: 60 }, (_, i) => ({
    lat: 6.9 + (0.02 * i) / 59, lng: 79.85 + dLng, t: 1_700_000_000_000 + i * 5000, acc: 8
  })),
  stops: [
    { lat: 6.905, lng: 79.85 + dLng, name: stopNames[0] },
    { lat: 6.915, lng: 79.85 + dLng, name: stopNames[1] }
  ]
});

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await Driver.syncIndexes();
  await RouteRecordingRun.syncIndexes();
  await new Promise((resolve) => server.listen(0, () => resolve()));
  port = server.address().port;

  manager = await createManager({ name: 'E2E Manager' });
  driver = await createDriver({ name: 'E2E Driver', fields: { managerId: manager.id } });
  route = await createProvisionalRoute({ managerId: manager.id });
  vehicle = await Vehicle.create({
    vehicleId: 'E2E-V-1',
    vehicleName: 'Blue Van',
    registrationNumber: 'E2E-REG-1',
    numberPlate: 'E2E-1001',
    driverId: driver.id,
    managerId: manager.id,
    routeId: route.routeId
  });

  // The parent of a child who lives beside the first stop.
  parent = await createRider({ name: 'Nimal Parent' });
  profile = await RiderProfile.create({
    _id: parent.id, accountId: parent.id, riderCode: 'TMR-E2E-0001', fullName: 'Nimal Perera'
  });
  const home = await HouseholdPlace.create({
    accountId: parent.id,
    label: 'Home',
    address: 'Beside the first stop',
    coordinates: { lat: 6.905, lng: 79.85 + 25 / (METERS * Math.cos(6.9 * Math.PI / 180)) }
  });
  await DriverEnrollment.create({
    studentId: profile._id, driverId: driver.id, managerId: manager.id, status: 'ACTIVE', pickupPlaceId: home._id
  });
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  liveVehicles.reset();
  stopArrivals.reset();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  rateLimit.reset();
  pushSpy = jest.spyOn(pushHelper, 'sendArrivalPush').mockResolvedValue({ sent: 1 });
});
afterEach(() => pushSpy.mockRestore());

// Drive the confirmed line once, slowly through each stop, fast between.
async function driveRoute(driverClient, lineCoords, stops) {
  const fixes = geo.resamplePolyline(lineCoords, 45);
  for (const p of fixes) {
    const nearStop = stops.some((s) => geo.haversineKm(p.lat, p.lng, s.lat, s.lng) * 1000 < 40);
    // eslint-disable-next-line no-await-in-loop
    const ack = await emit(driverClient, 'driver:location', {
      vehicleId: 'E2E-V-1', lat: p.lat, lng: p.lng, speed: nearStop ? 0.5 : 10, accuracy: 8, timestamp: Date.now()
    });
    expect(ack.success).toBe(true);
  }
}

describe('record -> confirm -> parent sees stops -> shuttle arrives -> parent is told', () => {
  it('runs the whole flow', async () => {
    // 1. The driver records five rides over the REST API, naming the stops. One ride types the
    //    name slightly differently and one leaves the second stop unnamed.
    const rides = [
      recordedRide(0, ["Nimal's house", 'School gate']),
      recordedRide(0.00003, ["Nimal's house", 'School gate']),
      recordedRide(-0.00003, ['Nimals house', 'School gate']),
      recordedRide(0.00002, ["Nimal's house", '']),
      recordedRide(-0.00002, ["Nimal's house", 'School gate'])
    ];
    for (const body of rides) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/driver/custom-routes/runs').set(...authHeader(driver.token)).send(body);
      expect([200, 201]).toContain(res.status);
      expect(res.body.data.run.status).toBe('ACCEPTED');
    }

    // 2. The fifth ride built the route and handed it to the manager; it is not live yet.
    let doc = await Route.findOne({ routeId: route.routeId }).lean();
    expect(doc.status).toBe('PENDING_REVIEW');
    expect(doc.stops.map((s) => s.stopName)).toEqual(["Nimal's house", 'School gate']);

    // 3. Nothing is announced and nothing is visible to the parent before the manager confirms -
    //    even though the shuttle is already driving and the (negative) cache is warm.
    const parentSocket = await connect(parent.token);
    const arrivals = [];
    parentSocket.on('vehicle:arrival', (e) => arrivals.push(e));
    const sub = await emit(parentSocket, 'vehicle:subscribe', { vehicleId: 'E2E-V-1', riderId: String(profile._id) });
    expect(sub.success).toBe(true);

    const driverSocket = await connect(driver.token);
    expect((await emit(driverSocket, 'driver:start-tracking', { vehicleId: 'E2E-V-1' })).success).toBe(true);
    const lineBeforeConfirm = decodePolyline(doc.pathPolyline);
    await emit(driverSocket, 'driver:location', { vehicleId: 'E2E-V-1', ...lineBeforeConfirm[Math.floor(lineBeforeConfirm.length / 4)], speed: 0, accuracy: 8 });
    await settle(200);
    expect(arrivals).toHaveLength(0);
    expect((await request(app).get(`/api/routes/${route.routeId}`).set(...authHeader(parent.token))).status).toBe(404);

    // 4. The manager confirms.
    const confirm = await request(app)
      .patch(`/api/manager/custom-routes/${route.routeId}/confirm`)
      .set(...authHeader(manager.token))
      .send({ routeName: 'Greenfield school run', fare: 0 });
    expect(confirm.status).toBe(200);
    doc = await Route.findOne({ routeId: route.routeId }).lean();
    expect(doc.status).toBe('ACTIVE');

    // 5. No more stops once the route is live: the driver's upload is refused.
    const tooLate = await request(app).post('/api/driver/custom-routes/runs').set(...authHeader(driver.token))
      .send(recordedRide(0, ['A', 'B']));
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.code).toBe('NOT_RECORDING');

    // 6. The parent now sees the route: the line and both stops, with the driver's names.
    const seen = await request(app).get(`/api/routes/${route.routeId}`).set(...authHeader(parent.token));
    expect(seen.status).toBe(200);
    const stops = (seen.body.data?.stops || seen.body.stops || []).map((s) => s.stopName);
    expect(stops).toEqual(["Nimal's house", 'School gate']);
    const path = await request(app).get(`/api/vehicle/routes/${route.routeId}/path`).set(...authHeader(parent.token));
    expect(path.status).toBe(200);

    // 7. The shuttle drives the whole confirmed line.
    await driveRoute(driverSocket, decodePolyline(doc.pathPolyline), doc.stops);

    // The parent saw the shuttle wait at BOTH stops, and was told "yours" only for the first.
    expect(await waitFor(() => arrivals.some((e) => e.stopOrder === 2))).toBe(true);
    const first = arrivals.filter((e) => e.stopOrder === 1);
    const second = arrivals.filter((e) => e.stopOrder === 2);
    expect(first.map((e) => e.forYou).sort()).toEqual([false, true]);
    expect(first[0].stopName).toBe("Nimal's house");
    expect(second.every((e) => e.forYou === false)).toBe(true);
    expect(second[0].stopName).toBe('School gate');

    // 8. One notification and one push, for the first stop only, naming the stop.
    expect(await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1))).toBe(true);
    const note = await Notification.findOne({ type: 'VEHICLE_ARRIVAL' }).lean();
    expect(String(note.userId)).toBe(String(parent.id));
    expect(note.title).toBe('Blue Van has arrived');
    expect(note.message).toContain("Nimal's house");
    await waitFor(() => pushSpy.mock.calls.length === 1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][2]).toMatchObject({ vehicleName: 'Blue Van', stopName: "Nimal's house" });

    // 9. Ending the shift leaves nothing waiting for a parent who opens the app afterwards.
    await emit(driverSocket, 'driver:stop-tracking', { vehicleId: 'E2E-V-1' });
    const late = await emit(parentSocket, 'vehicle:subscribe', { vehicleId: 'E2E-V-1', riderId: String(profile._id) });
    expect(late.data.atStop).toBeNull();
    await VehicleLiveLocation.deleteMany({});
  });
});
