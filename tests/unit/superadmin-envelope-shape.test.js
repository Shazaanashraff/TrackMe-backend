// Issue #61: superAdminController's list endpoints had drifted onto three
// different response envelope shapes ({success,count,data}, {success,data,
// pagination}, bare {success,data}). This exercises the controller functions
// directly against mocked Mongoose models (no DB available in this
// environment — see docs/guides/ADDING_A_TEST.md's integration-test
// preference for response-shape changes; this is a substitute, not a
// replacement, for that coverage) to lock in the standardized shape:
//   - list endpoints always include `count` (the length of the returned page)
//   - list endpoints include `pagination` only when the request opted into
//     paging (page/limit query params)
//   - single-resource endpoints (one manager's own detail) stay bare
//     {success, data} — there is nothing to count or paginate.

jest.mock('../../src/models/Manager');
jest.mock('../../src/models/Vehicle');
jest.mock('../../src/models/Booking');
jest.mock('../../src/models/VehicleReview');

const Manager = require('../../src/models/Manager');
const Vehicle = require('../../src/models/Vehicle');
const Booking = require('../../src/models/Booking');
const VehicleReview = require('../../src/models/VehicleReview');
const superAdminController = require('../../src/controllers/superAdminController');

// A minimal stand-in for a Mongoose Query: every chained method (sort/select/
// skip/limit/populate) returns the same chainable object, and awaiting it
// resolves to whatever value the test configured — mirroring how the real
// query builder resolves once `await`ed.
function chainable(resolvedValue) {
  const obj = {
    sort: () => obj,
    select: () => obj,
    skip: () => obj,
    limit: () => obj,
    populate: () => obj,
    lean: () => Promise.resolve(resolvedValue),
    then: (resolve, reject) => Promise.resolve(resolvedValue).then(resolve, reject)
  };
  return obj;
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const next = jest.fn();

const sampleManager = {
  _id: 'mgr-1',
  name: 'Manager One',
  email: 'manager1@example.com',
  isActive: true,
  invitedAt: null,
  activatedAt: null,
  province: '',
  serviceType: 'PUBLIC',
  organization: null,
  createdAt: new Date(),
  updatedAt: new Date()
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getManagers response envelope (issue #61)', () => {
  it('includes count alongside data and pagination', async () => {
    Manager.find.mockReturnValue(chainable([sampleManager]));
    Manager.countDocuments.mockResolvedValue(1);

    const req = { query: {} };
    const res = mockRes();
    await superAdminController.getManagers(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.count).toBe(body.data.length);
    expect(body.count).toBe(1);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });
});

describe('getOperationsOverview response envelope (issue #61)', () => {
  beforeEach(() => {
    Manager.find.mockReturnValue(chainable([sampleManager]));
    Manager.countDocuments.mockResolvedValue(1);
    Vehicle.aggregate.mockResolvedValue([]);
    Booking.aggregate.mockResolvedValue([]);
    VehicleReview.aggregate.mockResolvedValue([]);
  });

  it('includes count but omits pagination when the caller does not opt into paging', async () => {
    const req = { query: {} };
    const res = mockRes();
    await superAdminController.getOperationsOverview(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.count).toBe(body.data.length);
    expect(body.count).toBe(1);
    expect(body.pagination).toBeUndefined();
  });

  it('includes count and pagination once the caller passes page/limit', async () => {
    const req = { query: { page: '1', limit: '10' } };
    const res = mockRes();
    await superAdminController.getOperationsOverview(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.count).toBe(body.data.length);
    expect(body.pagination).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
  });
});

describe('getManagerVehicleDetails response envelope (issue #61)', () => {
  it('stays a bare {success, data} single-resource response — no count/pagination', async () => {
    Manager.findById.mockReturnValue(chainable(sampleManager));
    Vehicle.find.mockReturnValue(chainable([]));
    Booking.aggregate.mockResolvedValue([]);
    VehicleReview.aggregate.mockResolvedValue([]);

    const req = { params: { managerId: 'mgr-1' } };
    const res = mockRes();
    await superAdminController.getManagerVehicleDetails(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.manager).toBeTruthy();
    expect(body.count).toBeUndefined();
    expect(body.pagination).toBeUndefined();
  });
});
