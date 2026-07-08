const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Bus = require('../../src/models/Bus');
const Organization = require('../../src/models/Organization');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// The manager dashboard is service-aware: it returns the manager's serviceType,
// their organization name (private services), and a driverCount so the WebAdmin
// can show a fleet/driver view for school/office managers instead of buses/bookings.

let managerToken;
let manager;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const org = await Organization.create({ name: 'Royal College', serviceType: 'SCHOOL' });
  manager = await User.create({
    name: 'School Mgr', email: `school-mgr-${Date.now()}@t.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true, serviceType: 'SCHOOL', organization: org._id
  });

  const d1 = await User.create({ name: 'D1', email: `d1-${Date.now()}@t.com`, password: 'Driver@123', role: 'driver', isEmailVerified: true, isActive: true });
  const d2 = await User.create({ name: 'D2', email: `d2-${Date.now()}@t.com`, password: 'Driver@123', role: 'driver', isEmailVerified: true, isActive: true });

  const baseBus = (n, driverId) => ({
    busId: `SVH-${Date.now()}-${n}`,
    busName: `Van ${n}`,
    registrationNumber: `REG-${Date.now()}-${n}`,
    numberPlate: `NP-${Date.now()}-${n}`,
    routeId: `R-${n}`,
    managerId: manager._id,
    driverId,
    seatCapacity: 20,
    busType: 'NON-AC',
    serviceType: 'SCHOOL',
    isActive: true,
    isDeleted: false
  });
  // Two active vehicles with two distinct drivers.
  await Bus.create(baseBus(1, d1._id));
  await Bus.create(baseBus(2, d2._id));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('Manager dashboard (service-aware)', () => {
  it('login returns the manager serviceType in the user payload', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: manager.email, password: 'P@ssw0rd!' });
    expect(res.status).toBe(200);
    expect(res.body.user.serviceType).toBe('SCHOOL');
    managerToken = res.body.accessToken;
  });

  it('dashboard returns serviceType, organizationName, driverCount and fleet totals', async () => {
    const res = await request(app)
      .get('/api/manager/dashboard')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.serviceType).toBe('SCHOOL');
    expect(res.body.data.organizationName).toBe('Royal College');
    expect(res.body.data.driverCount).toBe(2);
    expect(res.body.data.fleet.totalBuses).toBe(2);
    expect(res.body.data.fleet.activeBuses).toBe(2);
  });
});
