const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin } = require('./factories');

// Issue #81: reviewVehicleRequest's CREATE_VEHICLE_ACCOUNT approval branch used
// to spread the manager-submitted vehicle payload straight into Vehicle.create()
// with no field whitelist. Fields the explicit override object sets afterward
// (managerId, driverId, isActive, isDeleted) already win over anything spread
// in — object-literal keys declared after a spread always take precedence — so
// this proves the whitelist against a field that ISN'T re-set afterward and
// therefore would have passed straight through pre-fix.

const stamp = Date.now();

let superAdminToken;
let managerId;
let route;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await createSuperAdmin({ name: 'Review Whitelist Admin' });
  superAdminToken = superAdmin.token;

  // Only ever referenced as the request's managerId, so it never signs in.
  const manager = await createManager({ name: 'Whitelist Manager', signIn: false });
  managerId = manager.id;

  route = await Route.create({
    routeId: `WL-ROUTE-${stamp}`,
    routeName: 'Whitelist Route',
    source: 'A',
    destination: 'B',
    distance: 10,
    estimatedTime: 20,
    fare: 50,
    serviceType: 'PUBLIC',
    isActive: true
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('PATCH /api/super-admin/vehicle-requests/:requestId/review — CREATE_VEHICLE_ACCOUNT', () => {
  it('does not persist a field outside the vehicle-creation whitelist from the submitted payload', async () => {
    const requestDoc = await ManagerVehicleRequest.create({
      type: 'CREATE_VEHICLE_ACCOUNT',
      managerId,
      vehicleId: `WL-VEH-${stamp}`,
      payload: {
        vehicle: {
          vehicleId: `WL-VEH-${stamp}`,
          vehicleName: 'Whitelist Vehicle',
          numberPlate: `WLV-${stamp}`,
          routeId: route.routeId,
          vehicleType: 'AC',
          serviceType: 'PUBLIC',
          // Not part of the whitelist — a manager-submitted request should
          // never be able to set a vehicle's maintenance status directly.
          maintenanceStatus: 'OUT_OF_SERVICE'
        },
        driver: {
          name: 'Whitelist Driver',
          email: `drv-whitelist-${stamp}@t.com`,
          phoneNumber: '0761234567',
          password: 'P@ssw0rd!'
        }
      }
    });

    const res = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestDoc._id}/review`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(200);

    const vehicle = await Vehicle.findOne({ vehicleId: `WL-VEH-${stamp}` });
    expect(vehicle).not.toBeNull();
    expect(vehicle.maintenanceStatus).toBe('ACTIVE');
  });
});
