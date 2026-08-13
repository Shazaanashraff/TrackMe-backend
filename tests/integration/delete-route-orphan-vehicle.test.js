const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Issue #50: deleteRoute soft-deleted a route with no check on Vehicle documents
// still referencing it via routeId, leaving vehicles dangling on a deleted route.
// Deletion now clears routeId off any vehicle referencing it, mirroring the
// existing "clear the dangling reference" pattern deleteManager already uses
// for a deleted manager's vehicles.

const stamp = Date.now();

let managerToken;
let manager;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  manager = await Manager.create({
    name: 'Delete Route Manager',
    email: `mgr-delroute-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  managerToken = (await request(app).post('/api/auth/login')
    .send({ email: manager.email, password: 'P@ssw0rd!' })).body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('DELETE /api/routes/:routeId unassigns referencing vehicles', () => {
  it('clears routeId off vehicles referencing the deleted route and reports the count', async () => {
    const route = await Route.create({
      routeId: `DELROUTE-${stamp}`,
      routeName: 'Delete Route Test',
      source: 'Colombo', destination: 'Kandy',
      distance: 100, fare: 200, estimatedTime: 120,
      serviceType: 'PUBLIC',
      managerId: manager._id
    });

    const vehicleA = await Vehicle.create({
      vehicleId: `DELROUTE-V-A-${stamp}`,
      vehicleName: 'Route Vehicle A',
      numberPlate: `DRA-${stamp}`,
      registrationNumber: `AUTO-DELROUTE-A-${stamp}`,
      routeId: route.routeId,
      managerId: manager._id
    });
    const vehicleB = await Vehicle.create({
      vehicleId: `DELROUTE-V-B-${stamp}`,
      vehicleName: 'Route Vehicle B',
      numberPlate: `DRB-${stamp}`,
      registrationNumber: `AUTO-DELROUTE-B-${stamp}`,
      routeId: route.routeId,
      managerId: manager._id
    });
    // A deleted vehicle already referencing the route should not be touched.
    const deletedVehicle = await Vehicle.create({
      vehicleId: `DELROUTE-V-DEL-${stamp}`,
      vehicleName: 'Already Deleted Vehicle',
      numberPlate: `DRD-${stamp}`,
      registrationNumber: `AUTO-DELROUTE-DEL-${stamp}`,
      routeId: route.routeId,
      managerId: manager._id,
      isDeleted: true
    });
    // A vehicle on an unrelated route should be untouched.
    const unrelatedVehicle = await Vehicle.create({
      vehicleId: `DELROUTE-V-UNREL-${stamp}`,
      vehicleName: 'Unrelated Vehicle',
      numberPlate: `DRU-${stamp}`,
      registrationNumber: `AUTO-DELROUTE-UNREL-${stamp}`,
      routeId: `SOME-OTHER-ROUTE-${stamp}`,
      managerId: manager._id
    });

    const res = await request(app).delete(`/api/routes/${route.routeId}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.unassignedVehicles).toBe(2);

    const reloadedA = await Vehicle.findById(vehicleA._id);
    const reloadedB = await Vehicle.findById(vehicleB._id);
    expect(reloadedA.routeId).toBe('');
    expect(reloadedB.routeId).toBe('');

    const reloadedDeleted = await Vehicle.findById(deletedVehicle._id);
    expect(reloadedDeleted.routeId).toBe(route.routeId);

    const reloadedUnrelated = await Vehicle.findById(unrelatedVehicle._id);
    expect(reloadedUnrelated.routeId).toBe(`SOME-OTHER-ROUTE-${stamp}`);
  });

  it('deletes cleanly with unassignedVehicles: 0 when no vehicle references the route', async () => {
    const route = await Route.create({
      routeId: `DELROUTE-NOVEH-${stamp}`,
      routeName: 'Delete Route No Vehicles',
      source: 'Colombo', destination: 'Galle',
      distance: 100, fare: 200, estimatedTime: 120,
      serviceType: 'PUBLIC',
      managerId: manager._id
    });

    const res = await request(app).delete(`/api/routes/${route.routeId}`)
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.unassignedVehicles).toBe(0);
  });
});
