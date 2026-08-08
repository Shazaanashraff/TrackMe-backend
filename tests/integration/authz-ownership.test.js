const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const User = require('../../src/models/User');
const SuperAdmin = require('../../src/models/SuperAdmin');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const Booking = require('../../src/models/Booking');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Ownership/authorization boundaries with no regression coverage before this
// (issue #17). Two of these (route edit/toggle, vehicle maintenance) turned out
// to have no ownership check at all in the controller — fixed alongside these
// tests rather than filed separately, per the issue's own instructions.

let managerAToken, managerBId;
let driverAToken, driverBToken, driverBId;
let superAdminToken;
let riderAToken, riderBToken, riderAId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const managerA = await Manager.create({
    name: 'Owner Manager', email: `mgrA-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const managerB = await Manager.create({
    name: 'Other Manager', email: `mgrB-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  managerBId = managerB._id;

  const driverA = await Driver.create({
    name: 'Driver A', email: `drvA-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const driverB = await Driver.create({
    name: 'Driver B', email: `drvB-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  driverBId = driverB._id;

  const superAdmin = await SuperAdmin.create({
    name: 'Root Admin', email: `sa-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });

  const riderA = await User.create({
    name: 'Rider A', email: `riderA-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  riderAId = riderA._id;
  const riderB = await User.create({
    name: 'Rider B', email: `riderB-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });

  const login = (email) => request(app).post('/api/auth/login').send({ email, password: 'P@ssw0rd!' })
    .then((res) => res.body.accessToken);

  managerAToken = await login(managerA.email);
  driverAToken = await login(driverA.email);
  driverBToken = await login(driverB.email);
  superAdminToken = await login(superAdmin.email);
  riderAToken = await login(riderA.email);
  riderBToken = await login(riderB.email);
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('Route edit ownership', () => {
  let ownRouteId;

  beforeAll(async () => {
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerAToken}`)
      .send({
        routeId: `AUTHZ-EDIT-${Date.now()}`, routeName: 'Owned Route',
        source: 'Colombo', destination: 'Kandy', distance: 100, fare: 200, estimatedTime: 120
      });
    ownRouteId = res.body.data.routeId;
  });

  it('lets the owning manager edit their own route', async () => {
    const res = await request(app).put(`/api/routes/${ownRouteId}`)
      .set('Authorization', `Bearer ${managerAToken}`)
      .send({ routeName: 'Renamed By Owner' });

    expect(res.status).toBe(200);
    expect(res.body.data.routeName).toBe('Renamed By Owner');
  });

  it('refuses a different manager editing it (403)', async () => {
    const managerB = await Manager.create({
      name: 'Editor B', email: `mgrB-edit-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      isEmailVerified: true, isActive: true
    });
    const managerBToken = (await request(app).post('/api/auth/login')
      .send({ email: managerB.email, password: 'P@ssw0rd!' })).body.accessToken;

    const res = await request(app).put(`/api/routes/${ownRouteId}`)
      .set('Authorization', `Bearer ${managerBToken}`)
      .send({ routeName: 'Hijacked' });

    expect(res.status).toBe(403);

    const stillOwned = await Route.findOne({ routeId: ownRouteId });
    expect(stillOwned.routeName).toBe('Renamed By Owner');
  });

  it('lets a super-admin edit any route', async () => {
    const res = await request(app).put(`/api/routes/${ownRouteId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ routeName: 'Renamed By SuperAdmin' });

    expect(res.status).toBe(200);
    expect(res.body.data.routeName).toBe('Renamed By SuperAdmin');
  });
});

describe('Route toggle ownership', () => {
  let ownRouteId, otherRouteId;

  beforeAll(async () => {
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerAToken}`)
      .send({
        routeId: `AUTHZ-TOGGLE-${Date.now()}`, routeName: 'Toggle Route',
        source: 'Colombo', destination: 'Galle', distance: 100, fare: 200, estimatedTime: 120
      });
    ownRouteId = res.body.data.routeId;

    const managerB = await Manager.create({
      name: 'Toggle B', email: `mgrB-toggle-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      isEmailVerified: true, isActive: true
    });
    const managerBToken = (await request(app).post('/api/auth/login')
      .send({ email: managerB.email, password: 'P@ssw0rd!' })).body.accessToken;
    const other = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerBToken}`)
      .send({
        routeId: `AUTHZ-TOGGLE-OTHER-${Date.now()}`, routeName: 'Other Toggle Route',
        source: 'Colombo', destination: 'Matara', distance: 100, fare: 200, estimatedTime: 120
      });
    otherRouteId = other.body.data.routeId;
  });

  it('refuses a manager toggling a route they do not own', async () => {
    const before = await Route.findOne({ routeId: otherRouteId });

    const res = await request(app).patch(`/api/routes/${otherRouteId}/toggle`)
      .set('Authorization', `Bearer ${managerAToken}`);

    expect(res.status).toBe(403);
    const after = await Route.findOne({ routeId: otherRouteId });
    expect(after.isActive).toBe(before.isActive);
  });

  it('lets the owning manager toggle their own route', async () => {
    const before = await Route.findOne({ routeId: ownRouteId });

    const res = await request(app).patch(`/api/routes/${ownRouteId}/toggle`)
      .set('Authorization', `Bearer ${managerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(!before.isActive);
  });
});

describe('Bus (vehicle) edit ownership', () => {
  let routeId, vehicleId;

  beforeAll(async () => {
    const route = await Route.create({
      routeId: `AUTHZ-VEH-R-${Date.now()}`, routeName: 'Vehicle Authz Route',
      source: 'Colombo', destination: 'Negombo', distance: 40, fare: 80, estimatedTime: 50, serviceType: 'PUBLIC'
    });
    routeId = route.routeId;

    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverAToken}`)
      .send({
        vehicleId: `AUTHZ-VEH-${Date.now()}`, vehicleName: 'Owned Bus',
        registrationNumber: `REGV-${Date.now()}`, numberPlate: `CAB-${2000 + Math.floor(Math.random() * 999)}`,
        routeId, seatCapacity: 40
      });
    vehicleId = res.body.data.vehicleId;
  });

  it('refuses a different driver editing another driver\'s bus (403)', async () => {
    const res = await request(app).put(`/api/vehicle/${vehicleId}`)
      .set('Authorization', `Bearer ${driverBToken}`)
      .send({ vehicleName: 'Hijacked Bus' });

    expect(res.status).toBe(403);

    const stillOwned = await Vehicle.findOne({ vehicleId });
    expect(stillOwned.vehicleName).toBe('Owned Bus');
  });

  it('lets the owning driver edit their own bus', async () => {
    const res = await request(app).put(`/api/vehicle/${vehicleId}`)
      .set('Authorization', `Bearer ${driverAToken}`)
      .send({ vehicleName: 'Renamed By Owner' });

    expect(res.status).toBe(200);
    expect(res.body.data.vehicleName).toBe('Renamed By Owner');
  });
});

describe('Bus maintenance-flag ownership', () => {
  let routeId, vehicleId;

  beforeAll(async () => {
    const route = await Route.create({
      routeId: `AUTHZ-MAINT-R-${Date.now()}`, routeName: 'Maintenance Authz Route',
      source: 'Colombo', destination: 'Kalutara', distance: 40, fare: 80, estimatedTime: 50, serviceType: 'PUBLIC'
    });
    routeId = route.routeId;

    const res = await request(app).post('/api/vehicle/register')
      .set('Authorization', `Bearer ${driverAToken}`)
      .send({
        vehicleId: `AUTHZ-MAINT-${Date.now()}`, vehicleName: 'Maint Bus',
        registrationNumber: `REGM-${Date.now()}`, numberPlate: `CAB-${3000 + Math.floor(Math.random() * 999)}`,
        routeId, seatCapacity: 40
      });
    vehicleId = res.body.data.vehicleId;
  });

  it('refuses a driver who does not own the bus (403)', async () => {
    const res = await request(app).patch(`/api/vehicle/${vehicleId}/maintenance`)
      .set('Authorization', `Bearer ${driverBToken}`)
      .send({ maintenanceStatus: 'MAINTENANCE' });

    expect(res.status).toBe(403);

    const stillActive = await Vehicle.findOne({ vehicleId });
    expect(stillActive.maintenanceStatus).not.toBe('MAINTENANCE');
  });

  it('refuses an unrelated manager (403)', async () => {
    const res = await request(app).patch(`/api/vehicle/${vehicleId}/maintenance`)
      .set('Authorization', `Bearer ${managerAToken}`)
      .send({ maintenanceStatus: 'MAINTENANCE' });

    expect(res.status).toBe(403);
  });

  it('lets the owning driver set maintenance status', async () => {
    const res = await request(app).patch(`/api/vehicle/${vehicleId}/maintenance`)
      .set('Authorization', `Bearer ${driverAToken}`)
      .send({ maintenanceStatus: 'MAINTENANCE' });

    expect(res.status).toBe(200);
    expect(res.body.data.maintenanceStatus).toBe('MAINTENANCE');
  });
});

describe('Booking read ownership', () => {
  let bookingId;

  beforeAll(async () => {
    const route = await Route.create({
      routeId: `AUTHZ-BOOK-R-${Date.now()}`, routeName: 'Booking Authz Route',
      source: 'Colombo', destination: 'Panadura', distance: 30, fare: 60, estimatedTime: 40, serviceType: 'PUBLIC'
    });
    const vehicle = await Vehicle.create({
      vehicleId: `AUTHZ-BOOK-V-${Date.now()}`, vehicleName: 'Booking Bus',
      registrationNumber: `REGB-${Date.now()}`, numberPlate: `CAB-${4000 + Math.floor(Math.random() * 999)}`,
      routeId: route.routeId, driverId: driverBId
    });
    const booking = await Booking.create({
      userId: riderAId,
      vehicleId: vehicle._id,
      routeId: route._id,
      seatNumbers: [1],
      totalPassengers: 1,
      pricePerSeat: 60,
      totalPrice: 60,
      journeyDate: new Date('2030-01-01')
    });
    bookingId = booking._id;
  });

  it('refuses a different rider reading the booking', async () => {
    const res = await request(app).get(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${riderBToken}`);

    expect([403, 404]).toContain(res.status);
  });

  it('lets the owning rider read their own booking', async () => {
    const res = await request(app).get(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${riderAToken}`);

    expect(res.status).toBe(200);
    expect(String(res.body._id || res.body.booking?._id)).toBe(String(bookingId));
  });
});

describe('Cross-manager attendance access', () => {
  let managerBToken, managerBRouteId, riderOnBRouteId;

  beforeAll(async () => {
    const managerB = await Manager.create({
      name: 'Attendance B', email: `mgrB-attend-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      isEmailVerified: true, isActive: true
    });
    managerBToken = (await request(app).post('/api/auth/login')
      .send({ email: managerB.email, password: 'P@ssw0rd!' })).body.accessToken;

    const routeB = await Route.create({
      routeId: `AUTHZ-ATT-B-${Date.now()}`, routeName: 'B Route',
      source: 'Colombo', destination: 'Ja-Ela', distance: 20, fare: 40, estimatedTime: 30,
      serviceType: 'PUBLIC', managerId: managerB._id
    });
    managerBRouteId = routeB.routeId;

    const riderOnBRoute = await User.create({
      name: 'Rider On B', email: `riderB2-authz-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      role: 'user', isEmailVerified: true, isActive: true
    });
    riderOnBRouteId = riderOnBRoute._id;

    await BoardingEvent.create({
      studentId: riderOnBRouteId,
      vehicleId: `SOME-VEH-${Date.now()}`,
      routeId: managerBRouteId,
      driverId: driverBId,
      type: 'BOARD'
    });
  });

  it('does not surface a rider who only rode another manager\'s route', async () => {
    const res = await request(app).get('/api/manager/attendance')
      .set('Authorization', `Bearer ${managerAToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((row) => String(row.studentId));
    expect(ids).not.toContain(String(riderOnBRouteId));
  });

  it('refuses an explicit request for a route the manager does not own', async () => {
    const res = await request(app).get(`/api/manager/attendance?routeId=${managerBRouteId}`)
      .set('Authorization', `Bearer ${managerAToken}`);

    expect(res.status).toBe(403);
  });

  it('lets manager B see the rider on their own route', async () => {
    const res = await request(app).get('/api/manager/attendance')
      .set('Authorization', `Bearer ${managerBToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((row) => String(row.studentId));
    expect(ids).toContain(String(riderOnBRouteId));
  });
});
