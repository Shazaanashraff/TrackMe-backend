const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const Vehicle = require('../../../src/models/Vehicle');
const Route = require('../../../src/models/Route');
const DriverEnrollment = require('../../../src/models/DriverEnrollment');
const RiderProfile = require('../../../src/models/RiderProfile');
const HouseholdPlace = require('../../../src/models/HouseholdPlace');
const Notification = require('../../../src/models/Notification');
const VehicleLiveLocation = require('../../../src/models/VehicleLiveLocation');
const liveVehicles = require('../../../src/utils/liveVehicles');
const rateLimit = require('../../../src/utils/socketRateLimit');
const pushHelper = require('../../../src/utils/pushHelper');
const stopArrivals = require('../../../src/services/stopArrivalNotifier');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');
const { createRider, createDriver, createManager } = require('../factories');

// A custom route's stops, a driver driving past them, and the parents watching.
//
// Real sockets, real database; only the Expo push is replaced so the test can see what
// would have been sent without a network call.

const BASE = { lat: 6.9, lng: 79.86 };
const at = (m, sideM = 0) => ({
  lat: BASE.lat + m / 111320,
  lng: BASE.lng + sideM / (111320 * Math.cos(BASE.lat * Math.PI / 180))
});

let port;
let manager;
let driver;
let vehicle;
let parentA; // rider whose pickup is near stop 1
let parentB; // rider whose pickup is near stop 2
let parentC; // enrolled, no pickup place saved
let profileA;
let profileB;
let profileC;
let pushSpy;

const clients = [];

function connect(token) {
  return new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
    c.on('connection-success', () => resolve(c));
    c.on('connect_error', reject);
    clients.push(c);
  });
}

const emit = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve));

// Collects every `event` a client receives, so a test can assert on exactly what arrived.
function collect(client, event) {
  const seen = [];
  client.on(event, (payload) => seen.push(payload));
  return seen;
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await settle(40);
  }
  return false;
}

const fix = (m, speed = 0, extra = {}) => ({
  vehicleId: 'ARR-V-1',
  ...at(m),
  speed,
  accuracy: 8,
  timestamp: Date.now(),
  ...extra
});

async function makeRider(name, pickupAtM) {
  const account = await createRider({ name });
  const profile = await RiderProfile.create({
    _id: account.id,
    accountId: account.id,
    riderCode: `TMR-${name.replace(/\W/g, '').toUpperCase()}-1`,
    fullName: name
  });
  let place = null;
  if (pickupAtM !== undefined) {
    place = await HouseholdPlace.create({
      accountId: account.id,
      label: 'Home',
      address: `${name}'s home`,
      coordinates: at(pickupAtM, 25)
    });
  }
  await DriverEnrollment.create({
    studentId: profile._id,
    driverId: driver.id,
    managerId: manager.id,
    status: 'ACTIVE',
    pickupPlaceId: place ? place._id : null
  });
  return { account, profile };
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await new Promise((resolve) => server.listen(0, () => resolve()));
  port = server.address().port;

  manager = await createManager({ name: 'Arrival Manager' });
  driver = await createDriver({ name: 'Arrival Driver', fields: { managerId: manager.id } });

  await Route.create({
    routeId: 'CUST-ARR-1',
    routeName: 'Morning run',
    source: 'Nimal house',
    destination: 'School gate',
    distance: 2,
    fare: 0,
    origin: 'RECORDED',
    status: 'ACTIVE',
    managerId: manager.id,
    stops: [
      { order: 1, stopName: "Nimal's house", ...at(500) },
      { order: 2, stopName: 'Kamala house', ...at(1500) }
    ],
    stopsCount: 2
  });

  vehicle = await Vehicle.create({
    vehicleId: 'ARR-V-1',
    vehicleName: 'Blue Van',
    registrationNumber: 'ARR-REG-1',
    numberPlate: 'AR-1001',
    driverId: driver.id,
    managerId: manager.id,
    routeId: 'CUST-ARR-1'
  });

  ({ account: parentA, profile: profileA } = await makeRider('Nimal Perera', 500));
  ({ account: parentB, profile: profileB } = await makeRider('Kamala Silva', 1500));
  ({ account: parentC, profile: profileC } = await makeRider('Chaminda Jay'));
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  liveVehicles.reset();
  stopArrivals.reset();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await VehicleLiveLocation.deleteMany({});
  await Notification.deleteMany({});
  liveVehicles.reset();
  stopArrivals.reset();
  rateLimit.reset();
  pushSpy = jest.spyOn(pushHelper, 'sendArrivalPush').mockResolvedValue({ sent: 1 });
});

afterEach(() => {
  pushSpy.mockRestore();
});

async function watch(account, profile) {
  const client = await connect(account.token);
  const arrivals = collect(client, 'vehicle:arrival');
  const departures = collect(client, 'vehicle:departure');
  const sub = await emit(client, 'vehicle:subscribe', { vehicleId: 'ARR-V-1', riderId: String(profile._id) });
  expect(sub.success).toBe(true);
  return { client, arrivals, departures, sub };
}

async function goLive() {
  const driverClient = await connect(driver.token);
  const started = await emit(driverClient, 'driver:start-tracking', { vehicleId: 'ARR-V-1' });
  expect(started.success).toBe(true);
  return driverClient;
}

describe('a shuttle pulling up to a stop on a confirmed custom route', () => {
  it('tells every watching parent where it is waiting, and only the stop\'s own parent "this is yours"', async () => {
    const a = await watch(parentA, profileA);
    const b = await watch(parentB, profileB);
    const driverClient = await goLive();

    // Driving north: fast, then slowing into stop 1 at 500 m.
    for (const m of [0, 200, 400]) await emit(driverClient, 'driver:location', fix(m, 12));
    await emit(driverClient, 'driver:location', fix(470, 2));

    expect(await waitFor(() => a.arrivals.length >= 2)).toBe(true);
    await settle();

    // A's pickup is at stop 1: gets the broadcast and the targeted "for you" event.
    expect(a.arrivals.map((e) => e.forYou).sort()).toEqual([false, true]);
    expect(a.arrivals[0]).toMatchObject({ vehicleId: 'ARR-V-1', stopOrder: 1, stopName: "Nimal's house" });

    // B watches the same shuttle but this is not B's stop.
    expect(b.arrivals).toHaveLength(1);
    expect(b.arrivals[0]).toMatchObject({ stopOrder: 1, forYou: false });
  });

  it('writes a notification and a push for the right parent only', async () => {
    await watch(parentA, profileA);
    const driverClient = await goLive();

    await emit(driverClient, 'driver:location', fix(480, 1));
    expect(await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1))).toBe(true);

    const note = await Notification.findOne({ type: 'VEHICLE_ARRIVAL' }).lean();
    expect(String(note.userId)).toBe(String(parentA.id));
    expect(String(note.studentId)).toBe(String(profileA._id));
    expect(note.title).toBe('Blue Van has arrived');
    expect(note.message).toContain("Nimal's house");
    expect(note.priority).toBe('HIGH');

    await waitFor(() => pushSpy.mock.calls.length === 1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const [student, , details] = pushSpy.mock.calls[0];
    expect(String(student._id)).toBe(String(profileA._id));
    expect(details).toMatchObject({ vehicleName: 'Blue Van', stopName: "Nimal's house", vehicleId: 'ARR-V-1' });
  });

  it('is told once per stop even if the same position is reported many times', async () => {
    await watch(parentA, profileA);
    const driverClient = await goLive();

    for (let i = 0; i < 6; i += 1) await emit(driverClient, 'driver:location', fix(495, 0));
    await settle(400);

    expect(await Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' })).toBe(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('does not tell again when the driver\'s app reconnects mid-stop', async () => {
    await watch(parentA, profileA);
    const first = await goLive();
    await emit(first, 'driver:location', fix(495, 0));
    await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1));

    // The phone drops and a fresh connection resumes the same shift without a new GO.
    first.disconnect();
    const second = await connect(driver.token);
    await emit(second, 'driver:location', fix(497, 0));
    await settle(400);

    expect(await Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' })).toBe(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a shuttle that only drives past at speed', async () => {
    const a = await watch(parentA, profileA);
    const driverClient = await goLive();

    for (const m of [400, 450, 500, 550, 600]) await emit(driverClient, 'driver:location', fix(m, 13));
    await settle(300);

    expect(a.arrivals).toHaveLength(0);
    expect(await Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' })).toBe(0);
  });

  it('says it has left when the shuttle drives away, and moves on to the next stop', async () => {
    const a = await watch(parentA, profileA);
    const b = await watch(parentB, profileB);
    const driverClient = await goLive();

    await emit(driverClient, 'driver:location', fix(500, 0));
    await waitFor(() => a.arrivals.length >= 2);
    await emit(driverClient, 'driver:location', fix(700, 9));
    expect(await waitFor(() => a.departures.length === 1)).toBe(true);
    expect(a.departures[0]).toMatchObject({ vehicleId: 'ARR-V-1', stopOrder: 1 });

    await emit(driverClient, 'driver:location', fix(1500, 0));
    expect(await waitFor(() => b.arrivals.some((e) => e.forYou === true))).toBe(true);
    expect(b.arrivals.find((e) => e.forYou)).toMatchObject({ stopOrder: 2, stopName: 'Kamala house' });
    expect(await Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' })).toBe(2);
  });

  it('a parent who opens the app while the shuttle is waiting is told straight away, including "this is yours"', async () => {
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0));
    await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1));

    const own = await watch(parentA, profileA);
    expect(own.sub.data.atStop).toMatchObject({ stopOrder: 1, stopName: "Nimal's house", forYou: true });

    const other = await watch(parentB, profileB);
    expect(other.sub.data.atStop).toMatchObject({ stopOrder: 1, forYou: false });
  });

  it('a late subscriber to a shuttle that is not at a stop gets atStop: null', async () => {
    await goLive();
    const own = await watch(parentA, profileA);
    expect(own.sub.data.atStop).toBeNull();
  });

  it('a rider with no saved pickup place sees the wait but is not notified', async () => {
    const c = await watch(parentC, profileC);
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0));

    expect(await waitFor(() => c.arrivals.length === 1)).toBe(true);
    expect(c.arrivals[0].forYou).toBe(false);
    await settle(300);
    expect(await Notification.countDocuments({ userId: parentC.id })).toBe(0);
  });

  it('the driver stopping while waiting clears the wait for watchers', async () => {
    const a = await watch(parentA, profileA);
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0));
    await waitFor(() => a.arrivals.length >= 2);

    await emit(driverClient, 'driver:stop-tracking', { vehicleId: 'ARR-V-1' });
    expect(await waitFor(() => a.departures.length === 1)).toBe(true);

    const late = await watch(parentA, profileA);
    expect(late.sub.data.atStop).toBeNull();
  });

  it('a new shift on the same day announces the stops again', async () => {
    await watch(parentA, profileA);
    const morning = await goLive();
    await emit(morning, 'driver:location', fix(500, 0));
    await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1));
    await emit(morning, 'driver:stop-tracking', { vehicleId: 'ARR-V-1' });

    const afternoon = await goLive();
    await emit(afternoon, 'driver:location', fix(500, 0));
    expect(await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 2))).toBe(true);
  });
});

describe('what the driver app sends cannot steer the check', () => {
  it('uses the vehicle\'s assigned route, not a routeId in the fix', async () => {
    const a = await watch(parentA, profileA);
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0, { routeId: 'CUST-DOES-NOT-EXIST' }));
    expect(await waitFor(() => a.arrivals.length >= 2)).toBe(true);
    expect(a.arrivals[0].routeId).toBe('CUST-ARR-1');
  });

  it('does not keep a cache entry for a route nobody drives', async () => {
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(100, 5, { routeId: 'CUST-FAKE-1' }));
    await emit(driverClient, 'driver:location', fix(120, 5, { routeId: 'CUST-FAKE-2' }));
    await settle(200);
    expect(await stopArrivals.stopsFor('CUST-ARR-1')).toHaveLength(2);
  });
});

describe('routes that are not confirmed custom routes', () => {
  it('a route still being recorded has no stop alerts', async () => {
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { status: 'RECORDING' } });
    stopArrivals.reset();
    const a = await watch(parentA, profileA);
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0));
    await settle(400);
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { status: 'ACTIVE' } });

    expect(a.arrivals).toHaveLength(0);
    expect(await Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' })).toBe(0);
  });

  it('a system route is left alone', async () => {
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { origin: 'SYSTEM' } });
    stopArrivals.reset();
    const a = await watch(parentA, profileA);
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(500, 0));
    await settle(400);
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { origin: 'RECORDED' } });

    expect(a.arrivals).toHaveLength(0);
  });

  it('changed stops take effect after the manager confirms (cache invalidated)', async () => {
    const driverClient = await goLive();
    await emit(driverClient, 'driver:location', fix(0, 10)); // primes the cache with the old stops
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { 'stops.0.stopName': 'Renamed by manager' } });
    stopArrivals.invalidateRoute('CUST-ARR-1');

    await watch(parentA, profileA);
    await emit(driverClient, 'driver:location', fix(500, 0));
    expect(await waitFor(() => Notification.countDocuments({ type: 'VEHICLE_ARRIVAL' }).then((n) => n === 1))).toBe(true);
    const note = await Notification.findOne({ type: 'VEHICLE_ARRIVAL' }).lean();
    expect(note.message).toContain('Renamed by manager');
    await Route.updateOne({ routeId: 'CUST-ARR-1' }, { $set: { 'stops.0.stopName': "Nimal's house" } });
  });
});

describe('a driver cannot be slowed by arrival work', () => {
  it('acknowledges a fix at a stop without waiting for notifications to finish', async () => {
    let release;
    pushSpy.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await watch(parentA, profileA);
    const driverClient = await goLive();

    const started = Date.now();
    const ack = await emit(driverClient, 'driver:location', fix(500, 0));
    expect(ack.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
    await waitFor(() => pushSpy.mock.calls.length === 1);
    release({ sent: 1 });
  });
});
