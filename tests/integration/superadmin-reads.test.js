const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const Booking = require('../../src/models/Booking');
const VehicleReview = require('../../src/models/VehicleReview');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin, createRider, authHeader } = require('./factories');

// Issue #70: getSuperAdminDashboard, getOperationsOverview, getManagerVehicleDetails
// (routed as GET /operations/:managerId — "getManagerBusDetails" pre-rename),
// getManagerById, and getPendingVehicleRequests (routed as GET /vehicle-requests —
// "getPendingBusRequests" pre-rename) had zero test coverage: no proof the KPI
// aggregation math (managers/vehicles/bookings/reviews counts) is correct, no 404
// coverage, and no proof of the status/type/managerId filtering on the vehicle-requests
// list. superadmin-operations-pagination.test.js already covers pagination on two of
// these endpoints, so this file focuses on content correctness instead of pagination.

const stamp = Date.now();

let superAdminToken;
let managerA;
let managerB;
let route;
let vehicleActive;
let vehicleInactive;
let vehicleB;

const auth = () => authHeader(superAdminToken);

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await createSuperAdmin({ name: 'Reads Admin' });
  superAdminToken = superAdmin.token;

  managerA = await createManager({ name: 'Reads Manager A', signIn: false });
  managerB = await createManager({ name: 'Reads Manager B', signIn: false });

  route = await Route.create({
    routeId: `SAR-ROUTE-${stamp}`,
    routeName: 'Reads Route',
    source: 'A',
    destination: 'B',
    distance: 10,
    estimatedTime: 20,
    fare: 50,
    serviceType: 'PUBLIC',
    isActive: true
  });

  vehicleActive = await Vehicle.create({
    vehicleId: `SAR-VEH-ACTIVE-${stamp}`,
    vehicleName: 'Active Vehicle',
    numberPlate: `SARA-${stamp}`,
    registrationNumber: `SARA-REG-${stamp}`,
    routeId: route.routeId,
    vehicleType: 'AC',
    serviceType: 'PUBLIC',
    managerId: managerA.id,
    isActive: true,
    isDeleted: false
  });

  vehicleInactive = await Vehicle.create({
    vehicleId: `SAR-VEH-INACTIVE-${stamp}`,
    vehicleName: 'Inactive Vehicle',
    numberPlate: `SARI-${stamp}`,
    registrationNumber: `SARI-REG-${stamp}`,
    routeId: route.routeId,
    vehicleType: 'AC',
    serviceType: 'PUBLIC',
    managerId: managerA.id,
    isActive: false,
    isDeleted: false
  });

  vehicleB = await Vehicle.create({
    vehicleId: `SAR-VEH-B-${stamp}`,
    vehicleName: 'Manager B Vehicle',
    numberPlate: `SARB-${stamp}`,
    registrationNumber: `SARB-REG-${stamp}`,
    routeId: route.routeId,
    vehicleType: 'AC',
    serviceType: 'PUBLIC',
    managerId: managerB.id,
    isActive: true,
    isDeleted: false
  });

  const rider = await createRider({ name: 'Reads Rider', signIn: false });

  await Booking.create({
    userId: rider.id,
    vehicleId: vehicleActive._id,
    routeId: route._id,
    seatNumbers: [1],
    totalPassengers: 1,
    pricePerSeat: 100,
    totalPrice: 100,
    status: 'CONFIRMED',
    journeyDate: new Date(),
    passengerDetails: [{ name: 'Rider', phone: '0761234567', gender: 'M' }],
    isDeleted: false
  });

  await Booking.create({
    userId: rider.id,
    vehicleId: vehicleActive._id,
    routeId: route._id,
    seatNumbers: [2],
    totalPassengers: 1,
    pricePerSeat: 100,
    totalPrice: 100,
    status: 'CANCELLED',
    journeyDate: new Date(),
    passengerDetails: [{ name: 'Rider', phone: '0761234567', gender: 'M' }],
    isDeleted: false
  });

  await VehicleReview.create({
    vehicleId: vehicleActive._id,
    userId: rider.id,
    rating: 4,
    isDeleted: false
  });

  await ManagerVehicleRequest.create({
    type: 'CREATE_VEHICLE_ACCOUNT',
    status: 'PENDING',
    managerId: managerA.id,
    vehicleId: `SAR-REQ-A-PENDING-${stamp}`
  });
  await ManagerVehicleRequest.create({
    type: 'DELETE_VEHICLE',
    status: 'APPROVED',
    managerId: managerA.id,
    vehicleId: `SAR-REQ-A-APPROVED-${stamp}`
  });
  await ManagerVehicleRequest.create({
    type: 'CREATE_VEHICLE_ACCOUNT',
    status: 'PENDING',
    managerId: managerB.id,
    vehicleId: `SAR-REQ-B-PENDING-${stamp}`
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/super-admin/dashboard', () => {
  it('reports correct manager/vehicle/booking/review KPI counts', async () => {
    const res = await request(app).get('/api/super-admin/dashboard').set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.managers.totalManagers).toBe(2);
    expect(res.body.data.managers.activeManagers).toBe(2);

    expect(res.body.data.vehicles.totalVehicles).toBe(3);
    expect(res.body.data.vehicles.activeVehicles).toBe(2);
    expect(res.body.data.vehicles.inactiveVehicles).toBe(1);

    expect(res.body.data.bookings.totalBookings).toBe(2);
    expect(res.body.data.bookings.confirmedBookings).toBe(1);
    expect(res.body.data.bookings.cancelledBookings).toBe(1);
    expect(res.body.data.bookings.totalRevenue).toBe(100);

    expect(res.body.data.reviews.totalReviews).toBe(1);
    expect(res.body.data.reviews.averageRating).toBe(4);
  });
});

describe('GET /api/super-admin/managers/:managerId', () => {
  it('reports a manager\'s fleet, booking, and review KPIs', async () => {
    const res = await request(app).get(`/api/super-admin/managers/${managerA.id}`).set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.fleet).toMatchObject({ totalVehicles: 2, activeVehicles: 1, inactiveVehicles: 1 });
    expect(res.body.data.bookingKpis).toMatchObject({
      totalBookings: 2,
      confirmedBookings: 1,
      cancelledBookings: 1,
      totalRevenue: 100
    });
    expect(res.body.data.reviewKpis).toEqual({ reviewCount: 1, averageRating: 4 });
  });

  it('404s for an unknown manager id', async () => {
    const missingId = new (require('mongoose').Types.ObjectId)();
    const res = await request(app).get(`/api/super-admin/managers/${missingId}`).set(...auth());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/super-admin/operations/:managerId', () => {
  it('lists a manager\'s vehicles with per-vehicle booking and review metrics', async () => {
    const res = await request(app).get(`/api/super-admin/operations/${managerA.id}`).set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.vehicles).toHaveLength(2);

    const active = res.body.data.vehicles.find((v) => v.vehicleId === vehicleActive.vehicleId);
    expect(active.bookingMetrics).toMatchObject({
      totalBookings: 2,
      confirmedBookings: 1,
      cancelledBookings: 1,
      totalRevenue: 100
    });
    expect(active.reviewMetrics).toEqual({ averageRating: 4, reviewCount: 1 });

    const inactive = res.body.data.vehicles.find((v) => v.vehicleId === vehicleInactive.vehicleId);
    expect(inactive.bookingMetrics).toEqual({
      totalBookings: 0,
      confirmedBookings: 0,
      cancelledBookings: 0,
      totalRevenue: 0
    });
  });

  it('404s for an unknown manager id', async () => {
    const missingId = new (require('mongoose').Types.ObjectId)();
    const res = await request(app).get(`/api/super-admin/operations/${missingId}`).set(...auth());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/super-admin/operations — per-manager content', () => {
  it('includes correct fleet/booking/review figures for each manager', async () => {
    const res = await request(app).get('/api/super-admin/operations').set(...auth());

    expect(res.status).toBe(200);
    const entryA = res.body.data.find((m) => m.managerId === String(managerA.id));
    const entryB = res.body.data.find((m) => m.managerId === String(managerB.id));

    expect(entryA.fleet).toMatchObject({ totalVehicles: 2, activeVehicles: 1, inactiveVehicles: 1 });
    expect(entryA.bookings.totalBookings).toBe(2);
    expect(entryA.reviews).toEqual({ averageRating: 4, reviewCount: 1 });

    expect(entryB.fleet).toMatchObject({ totalVehicles: 1, activeVehicles: 1, inactiveVehicles: 0 });
    expect(entryB.bookings.totalBookings).toBe(0);
    expect(entryB.reviews).toEqual({ averageRating: 0, reviewCount: 0 });
  });
});

describe('GET /api/super-admin/vehicle-requests — status/type/managerId filtering', () => {
  it('defaults to PENDING-only requests across both managers', async () => {
    const res = await request(app).get('/api/super-admin/vehicle-requests').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('status=ALL returns every request regardless of status', async () => {
    const res = await request(app).get('/api/super-admin/vehicle-requests?status=ALL').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('type filters to only the requested request type', async () => {
    const res = await request(app)
      .get('/api/super-admin/vehicle-requests?status=ALL&type=DELETE_VEHICLE')
      .set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe('DELETE_VEHICLE');
  });

  it('managerId filters to only that manager\'s requests', async () => {
    const res = await request(app)
      .get(`/api/super-admin/vehicle-requests?status=ALL&managerId=${managerB.id}`)
      .set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].managerId._id).toBe(String(managerB.id));
  });
});
