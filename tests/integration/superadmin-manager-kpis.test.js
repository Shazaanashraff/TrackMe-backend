const Vehicle = require('../../src/models/Vehicle');
const Booking = require('../../src/models/Booking');
const VehicleReview = require('../../src/models/VehicleReview');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager } = require('./factories');

// Issue #83: getManagerById/getOperationsOverview used to $lookup every Booking/
// VehicleReview document against `vehicles` and $match the joined managerId *after*
// the join, which can't use an index. The fix fetches each manager's vehicle ids
// first (managerId is indexed on Vehicle) and $matches Booking/VehicleReview
// directly on vehicleId (an index seek). KPI-correctness of the resulting numbers
// is already covered end-to-end by superadmin-reads.test.js (issue #70); this file
// covers the other half of #83's acceptance criteria — that the restructured
// aggregations actually hit an index seek, not a collection scan.

let manager;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  manager = await createManager({ name: 'Explain Manager', signIn: false });

  const route = await Route.create({
    routeId: `KPI-R-${Date.now()}`,
    routeName: 'KPI Test Route',
    source: 'Colombo',
    destination: 'Negombo',
    distance: 40,
    fare: 80,
    estimatedTime: 50,
    serviceType: 'PUBLIC'
  });

  await Vehicle.create({
    routeId: route.routeId,
    seatCapacity: 40,
    isActive: true,
    isDeleted: false,
    vehicleId: 'KPI-A1',
    vehicleName: 'Bus A1',
    registrationNumber: 'REG-KPI-A1',
    numberPlate: 'KPI-A1-PLATE',
    managerId: manager.id
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('super-admin KPI aggregations — index usage (issue #83)', () => {
  it('the Booking/VehicleReview $match-on-vehicleId aggregations hit an index seek, not a collection scan', async () => {
    const managerVehicleIds = await Vehicle.find({ managerId: manager.id, isDeleted: false }).distinct('_id');

    const bookingExplain = await Booking.aggregate([
      { $match: { isDeleted: false, vehicleId: { $in: managerVehicleIds } } },
      { $group: { _id: null, totalBookings: { $sum: 1 } } }
    ]).explain('queryPlanner');
    const bookingStage = JSON.stringify(bookingExplain);
    expect(bookingStage).toContain('IXSCAN');
    expect(bookingStage).not.toContain('COLLSCAN');

    const reviewExplain = await VehicleReview.aggregate([
      { $match: { isDeleted: false, vehicleId: { $in: managerVehicleIds } } },
      { $group: { _id: null, reviewCount: { $sum: 1 } } }
    ]).explain('queryPlanner');
    const reviewStage = JSON.stringify(reviewExplain);
    expect(reviewStage).toContain('IXSCAN');
    expect(reviewStage).not.toContain('COLLSCAN');
  });
});
