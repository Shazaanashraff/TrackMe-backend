const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin } = require('./factories');

// Issue #45: approving a DELETE_VEHICLE request set the vehicle isDeleted/isActive
// false but never touched its driver, leaving an orphaned live login with no
// vehicle behind it.

const stamp = Date.now();

let managerToken;
let superAdminToken;
let managerId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await createManager({ name: 'Delete Vehicle Manager' });
  managerId = manager.id;
  managerToken = manager.token;

  const superAdmin = await createSuperAdmin({ name: 'Delete Vehicle Admin' });
  superAdminToken = superAdmin.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('DELETE_VEHICLE approval deactivates the orphaned driver', () => {
  it('deactivates the vehicle\'s driver once the delete request is approved', async () => {
    const driver = await Driver.create({
      name: 'Orphaned Driver',
      email: `drv-delveh-${stamp}@t.com`,
      password: 'P@ssw0rd!',
      managerId,
      isActive: true,
      isEmailVerified: true
    });

    const vehicle = await Vehicle.create({
      vehicleId: `DELVEH-${stamp}`,
      vehicleName: 'Delete Vehicle Test',
      numberPlate: `DLV-${stamp}`,
      registrationNumber: `AUTO-DELVEH-${stamp}`,
      managerId,
      driverId: driver._id,
      isActive: true,
      isDeleted: false
    });

    const deleteReqRes = await request(app)
      .post(`/api/manager/vehicles/${vehicle.vehicleId}/delete-request`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'Vehicle retired' });
    expect(deleteReqRes.status).toBe(201);

    const requestId = deleteReqRes.body.data._id;

    const reviewRes = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ decision: 'APPROVE' });
    expect(reviewRes.status).toBe(200);

    const reloadedVehicle = await Vehicle.findById(vehicle._id);
    expect(reloadedVehicle.isDeleted).toBe(true);
    expect(reloadedVehicle.isActive).toBe(false);

    const reloadedDriver = await Driver.findById(driver._id);
    expect(reloadedDriver.isActive).toBe(false);
  });

  it('does not error when the vehicle has no driver assigned', async () => {
    const vehicle = await Vehicle.create({
      vehicleId: `DELVEH-NODRIVER-${stamp}`,
      vehicleName: 'Delete Vehicle No Driver',
      numberPlate: `DLN-${stamp}`,
      registrationNumber: `AUTO-DELVEH-NODRIVER-${stamp}`,
      managerId,
      driverId: null,
      isActive: true,
      isDeleted: false
    });

    const deleteReqRes = await request(app)
      .post(`/api/manager/vehicles/${vehicle.vehicleId}/delete-request`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reason: 'No driver assigned yet' });
    expect(deleteReqRes.status).toBe(201);

    const requestId = deleteReqRes.body.data._id;

    const reviewRes = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ decision: 'APPROVE' });
    expect(reviewRes.status).toBe(200);

    const reloadedVehicle = await Vehicle.findById(vehicle._id);
    expect(reloadedVehicle.isDeleted).toBe(true);
  });
});
