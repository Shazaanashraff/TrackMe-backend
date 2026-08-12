const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Issue #44: PATCH /api/manager/vehicle-accounts/:vehicleId/reset-password used
// to unconditionally set isActive/isEmailVerified true on every call, silently
// reactivating a driver whose account was deliberately deactivated.

const stamp = Date.now();

const login = (identifier, password) =>
  request(app).post('/api/auth/login').send({ identifier, password });

let managerToken;
let manager;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  manager = await Manager.create({
    name: 'Reset Password Manager',
    email: `mgr-resetpw-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  managerToken = (await login(manager.email, 'P@ssw0rd!')).body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

async function createVehicleWithDeactivatedDriver(suffix) {
  const driver = await Driver.create({
    name: `Reset Password Driver ${suffix}`,
    email: `drv-resetpw-${suffix}-${stamp}@t.com`,
    password: 'OldP@ssw0rd!',
    managerId: manager._id,
    isActive: false,
    isEmailVerified: false
  });

  const vehicle = await Vehicle.create({
    vehicleId: `RESETPW-VEH-${suffix}-${stamp}`,
    vehicleName: 'Reset Password Vehicle',
    numberPlate: `RPW-${suffix}-${stamp}`,
    registrationNumber: `AUTO-RESETPW-${suffix}-${stamp}`,
    managerId: manager._id,
    driverId: driver._id,
    isActive: true,
    isDeleted: false
  });

  return { driver, vehicle };
}

describe('PATCH /api/manager/vehicle-accounts/:vehicleId/reset-password', () => {
  it('does not reactivate a deliberately deactivated driver', async () => {
    const { driver, vehicle } = await createVehicleWithDeactivatedDriver('A');

    const res = await request(app)
      .patch(`/api/manager/vehicle-accounts/${vehicle.vehicleId}/reset-password`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ password: 'NewP@ssw0rd!' });

    expect(res.status).toBe(200);

    const reloaded = await Driver.findById(driver._id);
    expect(reloaded.isActive).toBe(false);
  });

  it('still verifies the email and updates the password', async () => {
    const { driver, vehicle } = await createVehicleWithDeactivatedDriver('B');

    const res = await request(app)
      .patch(`/api/manager/vehicle-accounts/${vehicle.vehicleId}/reset-password`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ password: 'NewP@ssw0rd!' });

    expect(res.status).toBe(200);

    const reloaded = await Driver.findById(driver._id).select('+password');
    expect(reloaded.isEmailVerified).toBe(true);

    const loginRes = await login(driver.email, 'NewP@ssw0rd!');
    // The driver is still deactivated, so login itself is refused — but with
    // the deactivated-account message, proving the new password was in fact
    // written (a stale password would 401 as bad credentials instead).
    expect(loginRes.status).toBe(403);
  });

  it('leaves an already-active driver active', async () => {
    const driver = await Driver.create({
      name: 'Still Active Driver',
      email: `drv-resetpw-active-${stamp}@t.com`,
      password: 'OldP@ssw0rd!',
      managerId: manager._id,
      isActive: true,
      isEmailVerified: true
    });
    const vehicle = await Vehicle.create({
      vehicleId: `RESETPW-VEH-ACTIVE-${stamp}`,
      vehicleName: 'Still Active Vehicle',
      numberPlate: `RPZ-${stamp}`,
      registrationNumber: `AUTO-RESETPW-ACTIVE-${stamp}`,
      managerId: manager._id,
      driverId: driver._id,
      isActive: true,
      isDeleted: false
    });

    const res = await request(app)
      .patch(`/api/manager/vehicle-accounts/${vehicle.vehicleId}/reset-password`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ password: 'NewP@ssw0rd!' });

    expect(res.status).toBe(200);

    const reloaded = await Driver.findById(driver._id);
    expect(reloaded.isActive).toBe(true);
  });
});
