const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Route = require('../../src/models/Route');
const Bus = require('../../src/models/Bus');
const BoardingEvent = require('../../src/models/BoardingEvent');
const RouteMembership = require('../../src/models/RouteMembership');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// GET /api/driver/boarding/roster — the driver-app "X / Y on board" card + roster page.
// Enrollment = ACTIVE RouteMembership on the bus's route; on-board status is derived from
// each rider's latest BoardingEvent within the resolved trip. Covers status derivation,
// the onBoardCount / enrolledCount headline, non-member "guests", and authorization.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

const TRIP = 'roster-trip';

let managerId, driverId, driverToken, otherDriverToken;
let route, bus;
let riderOn, riderOff, riderNever, guest;

async function makeRider(label) {
  const rider = await User.create({
    name: label, email: `roster-${label}-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  return rider;
}

async function enroll(rider) {
  await RouteMembership.create({
    userId: rider._id, routeId: route.routeId, managerId, status: 'ACTIVE', grantedVia: 'PIN'
  });
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await Manager.create({
    name: 'Roster Manager', email: `roster-mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  managerId = manager._id;

  const driver = await Driver.create({
    name: 'Roster Driver', email: `roster-drv-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  driverId = driver._id;
  driverToken = await loginAs(driver.email, 'P@ssw0rd!');

  const otherDriver = await Driver.create({
    name: 'Roster Other Driver', email: `roster-drv2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  otherDriverToken = await loginAs(otherDriver.email, 'P@ssw0rd!');

  route = await Route.create({
    routeId: `ROSTER-${Date.now()}`.toUpperCase(),
    routeName: 'Roster Route', source: 'A', destination: 'B', distance: 10, fare: 100,
    managerId, qrEnabled: true, visibility: 'PRIVATE',
    stops: [{ stopName: 'Stop A', order: 1, lat: 1, lng: 1 }], pathPolyline: 'abc'
  });

  bus = await Bus.create({
    busId: `ROSTER-BUS-${Date.now()}`, busName: 'Roster Shuttle',
    registrationNumber: `RREG-${Date.now()}`, numberPlate: `RPLT-${Date.now()}`,
    routeId: route.routeId, driverId, seatCapacity: 40, managerId
  });

  riderOn = await makeRider('Anna');     // BOARD → ON
  riderOff = await makeRider('Ben');     // BOARD then ALIGHT → OFF
  riderNever = await makeRider('Cara');  // no events → NOT_BOARDED
  guest = await makeRider('Zed');        // BOARD but NOT enrolled → guest

  await enroll(riderOn);
  await enroll(riderOff);
  await enroll(riderNever);
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

async function seedTripEvents() {
  await BoardingEvent.deleteMany({ tripId: TRIP });
  const base = Date.now() - 60_000;
  await BoardingEvent.create({
    studentId: riderOn._id, busId: bus.busId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
  await BoardingEvent.create({
    studentId: riderOff._id, busId: bus.busId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
  await BoardingEvent.create({
    studentId: riderOff._id, busId: bus.busId, routeId: route.routeId, driverId,
    type: 'ALIGHT', tripId: TRIP, timestamp: new Date(base + 10_000)
  });
  await BoardingEvent.create({
    studentId: guest._id, busId: bus.busId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
}

describe('GET /api/driver/boarding/roster', () => {
  beforeEach(seedTripEvents);
  afterEach(async () => { await BoardingEvent.deleteMany({ tripId: TRIP }); });

  it('returns the enrolled roster with per-rider on-board status and correct counts', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    const { enrolledCount, onBoardCount, roster } = res.body.data;
    expect(enrolledCount).toBe(3);
    expect(onBoardCount).toBe(1);
    expect(roster).toHaveLength(3);

    const byId = Object.fromEntries(roster.map((r) => [r.studentId, r]));
    expect(byId[String(riderOn._id)].status).toBe('ON');
    expect(byId[String(riderOff._id)].status).toBe('OFF');
    expect(byId[String(riderNever._id)].status).toBe('NOT_BOARDED');
    expect(byId[String(riderOn._id)].studentName).toBe('Anna');
  });

  it('sorts the roster ON → NOT_BOARDED → OFF', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.body.data.roster.map((r) => r.status)).toEqual(['ON', 'NOT_BOARDED', 'OFF']);
  });

  it('surfaces on-board non-members as guests, excluded from the enrolled headline', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);

    const { guests, roster, onBoardCount } = res.body.data;
    expect(guests).toHaveLength(1);
    expect(guests[0].studentId).toBe(String(guest._id));
    expect(roster.some((r) => r.studentId === String(guest._id))).toBe(false);
    expect(onBoardCount).toBe(1); // guest not counted in the enrolled on-board number
  });

  it('400s when busId is missing', async () => {
    const res = await request(app)
      .get('/api/driver/boarding/roster')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(400);
  });

  it('404s when the bus is not assigned to the requesting driver', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${otherDriverToken}`);
    expect(res.status).toBe(404);
  });

  it('403s a non-driver caller', async () => {
    const riderToken = await loginAs(riderOn.email, 'P@ssw0rd!');
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(res.status).toBe(403);
  });

  it('403s when the bus\'s route does not have QR attendance enabled', async () => {
    await Route.updateOne({ _id: route._id }, { $set: { qrEnabled: false } });
    const res = await request(app)
      .get(`/api/driver/boarding/roster?busId=${bus.busId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not enabled/i);
    await Route.updateOne({ _id: route._id }, { $set: { qrEnabled: true } });
  });
});
