const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const BoardingEvent = require('../../src/models/BoardingEvent');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// GET /api/driver/boarding/roster — the driver-app "X / Y on board" card + roster page.
// Enrollment = ACTIVE DriverEnrollment for the requesting driver; on-board status is
// derived from each rider's latest BoardingEvent within the resolved trip. Covers status
// derivation, the onBoardCount / enrolledCount headline, non-member "guests", and
// authorization.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

async function createLogin(role, name) {
  const email = `roster-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'P@ssw0rd!';
  const { doc } = await createIdentityWithProfile({
    email, password, isEmailVerified: true, role, fields: { name }
  });
  const token = await loginAs(email, password);
  return { id: doc._id, email, token };
}

const TRIP = 'roster-trip';

let managerId, driverId, driverToken, otherDriverToken;
let route, vehicle;
let riderOn, riderOff, riderNever, guest;

async function enroll(rider) {
  await DriverEnrollment.create({
    userId: rider.id, driverId, managerId, status: 'ACTIVE'
  });
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await createLogin('admin', 'Roster Manager');
  managerId = manager.id;

  const driver = await createLogin('driver', 'Roster Driver');
  driverId = driver.id;
  driverToken = driver.token;

  const otherDriver = await createLogin('driver', 'Roster Other Driver');
  otherDriverToken = otherDriver.token;

  route = await Route.create({
    routeId: `ROSTER-${Date.now()}`.toUpperCase(),
    routeName: 'Roster Route', source: 'A', destination: 'B', distance: 10, fare: 100,
    managerId, qrEnabled: true, visibility: 'PRIVATE',
    stops: [{ stopName: 'Stop A', order: 1, lat: 1, lng: 1 }], pathPolyline: 'abc'
  });

  vehicle = await Vehicle.create({
    vehicleId: `ROSTER-VEH-${Date.now()}`, vehicleName: 'Roster Shuttle',
    registrationNumber: `RREG-${Date.now()}`, numberPlate: `RPLT-${Date.now()}`,
    routeId: route.routeId, driverId, seatCapacity: 40, managerId
  });

  riderOn = await createLogin('user', 'Anna');    // BOARD → ON
  riderOff = await createLogin('user', 'Ben');     // BOARD then ALIGHT → OFF
  riderNever = await createLogin('user', 'Cara');  // no events → NOT_BOARDED
  guest = await createLogin('user', 'Zed');        // BOARD but NOT enrolled → guest

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
    studentId: riderOn.id, vehicleId: vehicle.vehicleId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
  await BoardingEvent.create({
    studentId: riderOff.id, vehicleId: vehicle.vehicleId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
  await BoardingEvent.create({
    studentId: riderOff.id, vehicleId: vehicle.vehicleId, routeId: route.routeId, driverId,
    type: 'ALIGHT', tripId: TRIP, timestamp: new Date(base + 10_000)
  });
  await BoardingEvent.create({
    studentId: guest.id, vehicleId: vehicle.vehicleId, routeId: route.routeId, driverId,
    type: 'BOARD', tripId: TRIP, timestamp: new Date(base)
  });
}

describe('GET /api/driver/boarding/roster', () => {
  beforeEach(seedTripEvents);
  afterEach(async () => { await BoardingEvent.deleteMany({ tripId: TRIP }); });

  it('returns the enrolled roster with per-rider on-board status and correct counts', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    const { enrolledCount, onBoardCount, roster } = res.body.data;
    expect(enrolledCount).toBe(3);
    expect(onBoardCount).toBe(1);
    expect(roster).toHaveLength(3);

    const byId = Object.fromEntries(roster.map((r) => [r.studentId, r]));
    expect(byId[String(riderOn.id)].status).toBe('ON');
    expect(byId[String(riderOff.id)].status).toBe('OFF');
    expect(byId[String(riderNever.id)].status).toBe('NOT_BOARDED');
    expect(byId[String(riderOn.id)].studentName).toBe('Anna');
  });

  it('sorts the roster ON → NOT_BOARDED → OFF', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.body.data.roster.map((r) => r.status)).toEqual(['ON', 'NOT_BOARDED', 'OFF']);
  });

  it('surfaces on-board non-members as guests, excluded from the enrolled headline', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);

    const { guests, roster, onBoardCount } = res.body.data;
    expect(guests).toHaveLength(1);
    expect(guests[0].studentId).toBe(String(guest.id));
    expect(roster.some((r) => r.studentId === String(guest.id))).toBe(false);
    expect(onBoardCount).toBe(1); // guest not counted in the enrolled on-board number
  });

  it('400s when vehicleId is missing', async () => {
    const res = await request(app)
      .get('/api/driver/boarding/roster')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(400);
  });

  it('404s when the vehicle is not assigned to the requesting driver', async () => {
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${otherDriverToken}`);
    expect(res.status).toBe(404);
  });

  it('403s a non-driver caller', async () => {
    const riderToken = await loginAs(riderOn.email, 'P@ssw0rd!');
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(res.status).toBe(403);
  });

  it('403s when the vehicle\'s route does not have QR attendance enabled', async () => {
    await Route.updateOne({ _id: route._id }, { $set: { qrEnabled: false } });
    const res = await request(app)
      .get(`/api/driver/boarding/roster?vehicleId=${vehicle.vehicleId}&tripId=${TRIP}`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not enabled/i);
    await Route.updateOne({ _id: route._id }, { $set: { qrEnabled: true } });
  });
});
