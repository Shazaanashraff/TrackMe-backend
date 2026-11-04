const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const RouteRecordingRun = require('../../src/models/RouteRecordingRun');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { createProvisionalRoute } = require('../../src/utils/customRoute');
const { _pathCache } = require('../../src/controllers/routeGeometryController');
const { encodePolyline } = require('../../src/utils/roadSnap');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const {
  createManager, createDriver, createRider, createSuperAdmin, authHeader
} = require('./factories');

// Custom routes: a manager marks a vehicle "custom", the driver records its first
// rides, the rides are merged into one road-following line, and the manager
// confirms it. The map matcher is mocked (it is an external service); everything
// else - auth, ownership, state changes, visibility - runs for real.

jest.mock('../../src/utils/mapMatch', () => {
  class MatchUnavailable extends Error {}
  return {
    MatchUnavailable,
    cleanTrace: (p) => p,
    // Stands in for OSRM: the "road" is simply the points as driven.
    matchRawTrace: jest.fn(async (points) => ({
      coords: points.map((p) => ({ lat: p.lat, lng: p.lng })),
      confidence: 0.9,
      provider: 'osrm',
      cleanedCount: points.length
    }))
  };
});
const { matchRawTrace, MatchUnavailable } = require('../../src/utils/mapMatch');

let seq = 0;
const stamp = Date.now();

// ~2.2 km straight north, 60 fixes 5 s apart. `dLng` nudges it sideways a few
// metres, as a different day's GPS would.
const ride = (dLng = 0, n = 60) => ({
  clientRunId: `run-${stamp}-${seq++}`,
  startedAt: new Date(1_700_000_000_000).toISOString(),
  endedAt: new Date(1_700_000_000_000 + 1_500_000).toISOString(),
  points: Array.from({ length: n }, (_, i) => ({
    lat: 6.9 + (0.02 * i) / (n - 1),
    lng: 79.85 + dLng,
    t: 1_700_000_000_000 + i * 5000,
    acc: 8
  })),
  stops: [
    { lat: 6.905, lng: 79.85 + dLng, name: 'School gate' },
    { lat: 6.915, lng: 79.85 + dLng }
  ]
});

// Starts and ends where `ride()` does, but bulges sideways in the middle - a different
// road for the middle of the journey. `amp` is in degrees of longitude (0.004 ~ 440 m).
const bulgedRide = (amp, n = 60) => {
  const base = ride(0, n);
  return {
    ...base,
    points: base.points.map((p, i) => ({ ...p, lng: 79.85 + amp * Math.sin((Math.PI * i) / (n - 1)) })),
    stops: []
  };
};

// A manager with one custom-route vehicle and its driver, signed in.
async function setupFleet() {
  const manager = await createManager({ name: `Custom Owner ${seq}` });
  const driver = await createDriver({ name: 'Recording Driver', fields: { managerId: manager.id } });
  const route = await createProvisionalRoute({ managerId: manager.id, serviceType: 'PUBLIC' });
  seq += 1;
  const vehicle = await Vehicle.create({
    vehicleId: `CR-V-${stamp}-${seq}`,
    vehicleName: `Custom Shuttle ${seq}`,
    registrationNumber: `CR-REG-${stamp}-${seq}`,
    numberPlate: `CBA-${4000 + seq}`,
    driverId: driver.id,
    managerId: manager.id,
    routeId: route.routeId,
    serviceType: 'PUBLIC',
    isActive: true,
    isDeleted: false
  });
  return {
    manager, driver, route, vehicle,
    asManager: () => authHeader(manager.token),
    asDriver: () => authHeader(driver.token)
  };
}

const postRun = (fleet, body) =>
  request(app).post('/api/driver/custom-routes/runs').set(...fleet.asDriver()).send(body);

// Submit n good rides.
async function recordRides(fleet, n, offsets = [0, 0.00003, -0.00003, 0.00002, -0.00002, 0.00001]) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await postRun(fleet, ride(offsets[i % offsets.length])));
  }
  return results;
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();
  await RouteRecordingRun.syncIndexes();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(() => {
  matchRawTrace.mockClear();
});

describe('creating a custom-route vehicle', () => {
  let manager;
  let routeId;

  beforeAll(async () => {
    const route = await Route.create({
      routeId: `CR-PUB-${stamp}`, routeName: 'Public Route', source: 'A', destination: 'B', distance: 10, fare: 50
    });
    routeId = route.routeId;
  });

  const body = (extra = {}) => ({
    vehicleId: `CR-NEW-${stamp}-${seq}`,
    vehicleName: 'Shuttle',
    numberPlate: `CAB-${5000 + seq++}`,
    driverName: 'New Driver',
    password: 'DriverPass1!',
    ...extra
  });

  it('provisions a RECORDING custom route and puts the vehicle on it (first vehicle)', async () => {
    manager = await createManager({ name: 'Bootstrap Custom' });
    const res = await request(app).post('/api/manager/vehicle-accounts')
      .set(...authHeader(manager.token)).send(body({ routeMode: 'CUSTOM' }));

    expect(res.status).toBe(201);
    const vehicle = await Vehicle.findOne({ vehicleId: res.body.data.vehicle.vehicleId }).lean();
    expect(vehicle.routeId).toMatch(/^CUST-[0-9A-F]{4}-[0-9A-F]{6}$/);

    const route = await Route.findOne({ routeId: vehicle.routeId }).lean();
    expect(route.origin).toBe('RECORDED');
    expect(route.status).toBe('RECORDING');
    expect(String(route.managerId)).toBe(String(manager.id));
    expect(route.recording.requiredRuns).toBe(5);
    expect(route.recording.acceptedRuns).toBe(0);
  });

  it('refuses a custom route together with an existing route id', async () => {
    const m = await createManager({ name: 'Both Choices' });
    const res = await request(app).post('/api/manager/vehicle-accounts')
      .set(...authHeader(m.token)).send(body({ routeMode: 'CUSTOM', routeId }));
    expect(res.status).toBe(400);
    expect(await Route.countDocuments({ origin: 'RECORDED', managerId: m.id })).toBe(0);
  });

  it('creates no route when the request is only submitted for approval, only when it is approved', async () => {
    const superAdmin = await createSuperAdmin({ name: 'Custom Approver' });
    const m = await createManager({ name: 'Second Vehicle Owner' });
    const auth = authHeader(m.token);
    // Past the bootstrap slot.
    const first = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body({ routeId }));
    expect(first.status).toBe(201);

    // Approval creates the driver's login, which needs an email.
    const second = body({ routeMode: 'CUSTOM', driverEmail: `cr-driver-${stamp}-${seq}@test.com` });
    const submitted = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(second);
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.type).toBe('CREATE_VEHICLE_ACCOUNT');
    expect(await Route.countDocuments({ origin: 'RECORDED', managerId: m.id })).toBe(0);

    const approved = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${submitted.body.data._id}/review`)
      .set(...authHeader(superAdmin.token))
      .send({ decision: 'APPROVE' });
    expect(approved.status).toBe(200);

    const vehicle = await Vehicle.findOne({ vehicleId: second.vehicleId }).lean();
    const route = await Route.findOne({ routeId: vehicle.routeId }).lean();
    expect(route.origin).toBe('RECORDED');
    expect(route.status).toBe('RECORDING');
    expect(String(route.managerId)).toBe(String(m.id));
  });

  it('leaves no route behind when the request is rejected', async () => {
    const superAdmin = await createSuperAdmin({ name: 'Custom Rejecter' });
    const m = await createManager({ name: 'Rejected Owner' });
    const auth = authHeader(m.token);
    await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body({ routeId }));
    const submitted = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body({ routeMode: 'CUSTOM' }));

    await request(app)
      .patch(`/api/super-admin/vehicle-requests/${submitted.body.data._id}/review`)
      .set(...authHeader(superAdmin.token))
      .send({ decision: 'REJECT', note: 'no' });

    expect(await Route.countDocuments({ origin: 'RECORDED', managerId: m.id })).toBe(0);
    expect((await ManagerVehicleRequest.findById(submitted.body.data._id)).status).toBe('REJECTED');
  });
});

describe('GET /api/driver/custom-routes/current', () => {
  it('reports "ride n of 5" for a driver on a custom route', async () => {
    const fleet = await setupFleet();
    const res = await request(app).get('/api/driver/custom-routes/current').set(...fleet.asDriver());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'RECORDING', requiredRuns: 5, acceptedRuns: 0, runs: [] });
  });

  it('returns null for a driver whose vehicle is on an ordinary route', async () => {
    const m = await createManager({ name: 'Plain Owner' });
    const d = await createDriver({ name: 'Plain Driver', fields: { managerId: m.id } });
    await Vehicle.create({
      vehicleId: `CR-PLAIN-${stamp}`, vehicleName: 'Plain', registrationNumber: `CR-PLAIN-REG-${stamp}`,
      numberPlate: 'CBA-9001', driverId: d.id, managerId: m.id, routeId: '', isActive: true, isDeleted: false
    });
    const res = await request(app).get('/api/driver/custom-routes/current').set(...authHeader(d.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('is for drivers only, and needs a sign-in', async () => {
    const fleet = await setupFleet();
    expect((await request(app).get('/api/driver/custom-routes/current')).status).toBe(401);
    expect((await request(app).get('/api/driver/custom-routes/current').set(...fleet.asManager())).status).toBe(403);
  });
});

describe('POST /api/driver/custom-routes/runs', () => {
  it('accepts a good ride, matches it to roads and counts it', async () => {
    const fleet = await setupFleet();
    const res = await postRun(fleet, ride());
    expect(res.status).toBe(201);
    expect(res.body.data.run).toMatchObject({ status: 'ACCEPTED', runNumber: 1 });
    expect(res.body.data.route).toMatchObject({ status: 'RECORDING', acceptedRuns: 1, requiredRuns: 5 });
    expect(matchRawTrace).toHaveBeenCalledTimes(1);

    const stored = await RouteRecordingRun.findById(res.body.data.run.id).lean();
    expect(stored.matched.polyline).toBeTruthy();
    expect(stored.points).toHaveLength(60);
  });

  it('is idempotent on clientRunId: a retried upload is one ride', async () => {
    const fleet = await setupFleet();
    const body = ride();
    const first = await postRun(fleet, body);
    const again = await postRun(fleet, body);
    expect(again.status).toBe(200);
    expect(again.body.data.run.id).toBe(first.body.data.run.id);
    expect(await RouteRecordingRun.countDocuments({ routeId: fleet.route.routeId })).toBe(1);
    expect(matchRawTrace).toHaveBeenCalledTimes(1);
  });

  it('rejects a ride with too few points, without matching it', async () => {
    const fleet = await setupFleet();
    const res = await postRun(fleet, ride(0, 8));
    expect(res.status).toBe(201);
    expect(res.body.data.run).toMatchObject({ status: 'REJECTED', rejectReason: 'TOO_FEW_POINTS' });
    expect(res.body.data.route.acceptedRuns).toBe(0);
    expect(matchRawTrace).not.toHaveBeenCalled();
  });

  it('rejects a ride that barely moved', async () => {
    const fleet = await setupFleet();
    const short = ride();
    short.points = short.points.map((p, i) => ({ ...p, lat: 6.9 + i * 0.000001 }));
    const res = await postRun(fleet, short);
    expect(res.body.data.run).toMatchObject({ status: 'REJECTED', rejectReason: 'TOO_SHORT' });
  });

  it('rejects an exact duplicate of an earlier ride under a new id', async () => {
    const fleet = await setupFleet();
    const body = ride();
    await postRun(fleet, body);
    const res = await postRun(fleet, { ...body, clientRunId: `dup-${stamp}-${seq++}` });
    expect(res.body.data.run).toMatchObject({ status: 'REJECTED', rejectReason: 'DUPLICATE' });
  });

  it('rejects a ride that is clearly a different route', async () => {
    const fleet = await setupFleet();
    await postRun(fleet, ride());
    const elsewhere = ride();
    elsewhere.points = elsewhere.points.map((p) => ({ ...p, lat: p.lat + 0.5, lng: p.lng + 0.5 }));
    const res = await postRun(fleet, elsewhere);
    expect(res.body.data.run).toMatchObject({ status: 'REJECTED', rejectReason: 'NOT_SAME_ROUTE' });
    expect(res.body.data.route.acceptedRuns).toBe(1);
  });

  it('requires a clientRunId', async () => {
    const fleet = await setupFleet();
    const body = ride();
    delete body.clientRunId;
    expect((await postRun(fleet, body)).status).toBe(400);
  });

  it('keeps a ride PENDING_MATCH when the matcher is down, and counts it once the matcher is back', async () => {
    const fleet = await setupFleet();
    matchRawTrace.mockRejectedValueOnce(new MatchUnavailable('down'));
    const res = await postRun(fleet, ride());
    expect(res.status).toBe(201);
    expect(res.body.data.run.status).toBe('PENDING_MATCH');
    expect(res.body.data.route.acceptedRuns).toBe(0);

    // The app asks for progress later; that retries the stuck ride.
    const current = await request(app).get('/api/driver/custom-routes/current').set(...fleet.asDriver());
    expect(current.body.data.acceptedRuns).toBe(1);
    expect(current.body.data.runs[0].status).toBe('ACCEPTED');
  });

  it('refuses rides for a driver whose vehicle is not on a custom route', async () => {
    const m = await createManager({ name: 'No Custom Owner' });
    const d = await createDriver({ name: 'No Custom Driver', fields: { managerId: m.id } });
    await Vehicle.create({
      vehicleId: `CR-NOC-${stamp}`, vehicleName: 'N', registrationNumber: `CR-NOC-REG-${stamp}`,
      numberPlate: 'CBA-9002', driverId: d.id, managerId: m.id, routeId: '', isActive: true, isDeleted: false
    });
    const res = await request(app).post('/api/driver/custom-routes/runs').set(...authHeader(d.token)).send(ride());
    expect(res.status).toBe(404);
  });

  it('one driver cannot discard or add to another driver\'s route', async () => {
    const a = await setupFleet();
    const b = await setupFleet();
    const accepted = await postRun(a, ride());
    const res = await request(app)
      .delete(`/api/driver/custom-routes/runs/${accepted.body.data.run.id}`)
      .set(...b.asDriver());
    expect(res.status).toBe(404);
    expect((await RouteRecordingRun.findById(accepted.body.data.run.id)).status).toBe('ACCEPTED');
  });

  it('lets the driver discard a ride so it stops counting, and renumbers the rest', async () => {
    const fleet = await setupFleet();
    const one = await postRun(fleet, ride(0));
    await postRun(fleet, ride(0.00003));
    const del = await request(app)
      .delete(`/api/driver/custom-routes/runs/${one.body.data.run.id}`)
      .set(...fleet.asDriver());
    expect(del.status).toBe(200);
    expect(del.body.data.route.acceptedRuns).toBe(1);
    const left = await RouteRecordingRun.findOne({ routeId: fleet.route.routeId, status: 'ACCEPTED' });
    expect(left.runNumber).toBe(1);
  });
});

describe('after the last ride', () => {
  it('builds the route and hands it to the manager (PENDING_REVIEW)', async () => {
    const fleet = await setupFleet();
    const results = await recordRides(fleet, 5);
    expect(results[4].body.data.route).toMatchObject({ status: 'PENDING_REVIEW', acceptedRuns: 5 });

    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.pathPolyline).toBeTruthy();
    expect(route.distance).toBeGreaterThan(2);
    expect(route.stops).toHaveLength(2);
    expect(route.stops[0].stopName).toBe('School gate');
    expect(route.recording.confidence).toBeGreaterThan(0.9);
    expect(route.recording.warning).toBe('');

    const count = await request(app).get('/api/manager/custom-routes/count').set(...fleet.asManager());
    expect(count.body.data.pendingReview).toBe(1);
  });

  it('stops accepting rides once the route is waiting for review', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    const res = await postRun(fleet, ride());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_RECORDING');
  });

  it('builds the route exactly once when the last two rides land together', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 3);
    await Promise.all([postRun(fleet, ride(0.00001)), postRun(fleet, ride(-0.00001))]);
    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.status).toBe('PENDING_REVIEW');
    expect(route.recording.acceptedRuns).toBeGreaterThanOrEqual(5);
  });

  it('flags RUNS_DISAGREE when the rides do not agree', async () => {
    const fleet = await setupFleet();
    // Five rides that start and end together but take five different roads between.
    for (const amp of [0, 0.004, 0.008, 0.012, 0.016]) {
      // eslint-disable-next-line no-await-in-loop
      await postRun(fleet, bulgedRide(amp));
    }
    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.status).toBe('PENDING_REVIEW');
    expect(route.recording.warning).toBe('RUNS_DISAGREE');
  });
});

describe('manager review and confirmation', () => {
  it('lists, shows the line and every ride, then confirms', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);

    const list = await request(app).get('/api/manager/custom-routes?status=PENDING_REVIEW').set(...fleet.asManager());
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ status: 'PENDING_REVIEW', acceptedRuns: 5, requiredRuns: 5 });
    expect(list.body.data[0].pathPolyline).toBeUndefined();

    const detail = await request(app).get(`/api/manager/custom-routes/${fleet.route.routeId}`).set(...fleet.asManager());
    expect(detail.status).toBe(200);
    expect(detail.body.data.pathPolyline).toBeTruthy();
    expect(detail.body.data.runs).toHaveLength(5);
    expect(detail.body.data.stops).toHaveLength(2);

    const confirmed = await request(app)
      .patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager())
      .send({ routeName: 'Greenfield School Run', source: 'Home', destination: 'School', fare: 120 });
    expect(confirmed.status).toBe(200);

    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route).toMatchObject({
      status: 'ACTIVE', routeName: 'Greenfield School Run', source: 'Home', destination: 'School', fare: 120, isActive: true
    });
  });

  it('requires a name, and a valid fare', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    const url = `/api/manager/custom-routes/${fleet.route.routeId}/confirm`;
    expect((await request(app).patch(url).set(...fleet.asManager()).send({ routeName: '  ' })).status).toBe(400);
    expect((await request(app).patch(url).set(...fleet.asManager()).send({ routeName: 'X', fare: -5 })).status).toBe(400);
    expect((await Route.findOne({ routeId: fleet.route.routeId })).status).toBe('PENDING_REVIEW');
  });

  it('cannot confirm a route that is still collecting rides, or confirm twice', async () => {
    const fleet = await setupFleet();
    const url = `/api/manager/custom-routes/${fleet.route.routeId}/confirm`;
    const early = await request(app).patch(url).set(...fleet.asManager()).send({ routeName: 'Early' });
    expect(early.status).toBe(409);

    await recordRides(fleet, 5);
    expect((await request(app).patch(url).set(...fleet.asManager()).send({ routeName: 'Once' })).status).toBe(200);
    const twice = await request(app).patch(url).set(...fleet.asManager()).send({ routeName: 'Twice' });
    expect(twice.status).toBe(409);
    expect((await Route.findOne({ routeId: fleet.route.routeId })).routeName).toBe('Once');
  });

  it('lets the manager edit the stops while confirming', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    await request(app)
      .patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager())
      .send({ routeName: 'Edited', stops: [{ stopName: 'Main gate', lat: 6.91, lng: 79.85 }] });
    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.stops).toHaveLength(1);
    expect(route.stops[0]).toMatchObject({ stopName: 'Main gate', order: 1 });
    expect(route.stopsCount).toBe(1);
  });

  it('record-more sends the route back to recording with a higher target', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    const res = await request(app)
      .post(`/api/manager/custom-routes/${fleet.route.routeId}/record-more`)
      .set(...fleet.asManager()).send({ extraRuns: 2 });
    expect(res.status).toBe(200);
    const route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route).toMatchObject({ status: 'RECORDING' });
    expect(route.recording.requiredRuns).toBe(7);
    expect(route.recording.acceptedRuns).toBe(5);

    // Two more rides rebuild it, and the earlier five still count.
    await recordRides(fleet, 2, [0.00001, -0.00001]);
    expect((await Route.findOne({ routeId: fleet.route.routeId })).status).toBe('PENDING_REVIEW');
  });

  it('validates record-more', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    const url = `/api/manager/custom-routes/${fleet.route.routeId}/record-more`;
    expect((await request(app).post(url).set(...fleet.asManager()).send({ extraRuns: 0 })).status).toBe(400);
    expect((await request(app).post(url).set(...fleet.asManager()).send({ extraRuns: 9 })).status).toBe(400);
  });

  it('re-recording keeps the live line until the new one is confirmed', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    await request(app).patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager()).send({ routeName: 'Live Route' });
    const liveLine = (await Route.findOne({ routeId: fleet.route.routeId })).pathPolyline;

    const re = await request(app).post(`/api/manager/custom-routes/${fleet.route.routeId}/rerecord`).set(...fleet.asManager());
    expect(re.status).toBe(200);
    let route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.status).toBe('RECORDING');
    expect(route.pathPolyline).toBe(liveLine);
    expect(route.recording.acceptedRuns).toBe(0);

    // New rides along a slightly different road.
    await recordRides(fleet, 5, [0.0002, 0.00022, 0.00018, 0.00021, 0.00019]);
    route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.status).toBe('PENDING_REVIEW');
    expect(route.pathPolyline).toBe(liveLine); // still the live one
    expect(route.recording.candidate.pathPolyline).toBeTruthy();
    expect(route.recording.candidate.pathPolyline).not.toBe(liveLine);

    await request(app).patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager()).send({ routeName: 'Live Route v2' });
    route = await Route.findOne({ routeId: fleet.route.routeId }).lean();
    expect(route.status).toBe('ACTIVE');
    expect(route.pathPolyline).not.toBe(liveLine);
    expect(route.recording.candidate.pathPolyline).toBe('');
  });

  it('only a confirmed route can be re-recorded', async () => {
    const fleet = await setupFleet();
    const res = await request(app).post(`/api/manager/custom-routes/${fleet.route.routeId}/rerecord`).set(...fleet.asManager());
    expect(res.status).toBe(409);
  });

  it('another manager gets a 404 on every endpoint', async () => {
    const fleet = await setupFleet();
    await recordRides(fleet, 5);
    const other = await createManager({ name: 'Intruder' });
    const as = authHeader(other.token);
    const id = fleet.route.routeId;

    expect((await request(app).get('/api/manager/custom-routes').set(...as)).body.data).toEqual([]);
    expect((await request(app).get(`/api/manager/custom-routes/${id}`).set(...as)).status).toBe(404);
    expect((await request(app).patch(`/api/manager/custom-routes/${id}/confirm`).set(...as).send({ routeName: 'Mine' })).status).toBe(404);
    expect((await request(app).post(`/api/manager/custom-routes/${id}/record-more`).set(...as).send({ extraRuns: 1 })).status).toBe(404);
    expect((await request(app).post(`/api/manager/custom-routes/${id}/rerecord`).set(...as)).status).toBe(404);
    expect((await Route.findOne({ routeId: id })).status).toBe('PENDING_REVIEW');
  });

  it('is manager-only', async () => {
    const fleet = await setupFleet();
    expect((await request(app).get('/api/manager/custom-routes')).status).toBe(401);
    expect((await request(app).get('/api/manager/custom-routes').set(...fleet.asDriver())).status).toBe(403);
  });

  it('confirmed custom routes are assignable to another vehicle, unconfirmed ones are not', async () => {
    const fleet = await setupFleet();
    const assignable = async () =>
      (await request(app).get('/api/manager/routes').set(...fleet.asManager())).body.data.map((r) => r.routeId);

    expect(await assignable()).not.toContain(fleet.route.routeId);
    await recordRides(fleet, 5);
    expect(await assignable()).not.toContain(fleet.route.routeId);

    await request(app).patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager()).send({ routeName: 'Shared Shuttle Route' });
    expect(await assignable()).toContain(fleet.route.routeId);

    // And the update endpoint agrees: a second vehicle can be put on it.
    const second = await Vehicle.create({
      vehicleId: `CR-2ND-${stamp}-${seq}`, vehicleName: 'Second', registrationNumber: `CR-2ND-REG-${stamp}-${seq}`,
      numberPlate: `CBA-${7000 + seq++}`, managerId: fleet.manager.id, routeId: '', serviceType: 'PUBLIC', isActive: true, isDeleted: false
    });
    const put = await request(app).put(`/api/manager/vehicles/${second.vehicleId}`)
      .set(...fleet.asManager()).send({ routeId: fleet.route.routeId });
    expect(put.status).toBe(200);
  });

  it('a route still being recorded cannot be given to another vehicle', async () => {
    const fleet = await setupFleet();
    seq += 1;
    const second = await Vehicle.create({
      vehicleId: `CR-3RD-${stamp}-${seq}`, vehicleName: 'Third', registrationNumber: `CR-3RD-REG-${stamp}-${seq}`,
      numberPlate: `CBA-${8000 + seq}`, managerId: fleet.manager.id, routeId: '', serviceType: 'PUBLIC', isActive: true, isDeleted: false
    });
    const put = await request(app).put(`/api/manager/vehicles/${second.vehicleId}`)
      .set(...fleet.asManager()).send({ routeId: fleet.route.routeId });
    expect(put.status).toBe(400);

    // ...but the vehicle already on it can be edited without losing it.
    const rename = await request(app).put(`/api/manager/vehicles/${fleet.vehicle.vehicleId}`)
      .set(...fleet.asManager()).send({ vehicleName: 'Renamed', routeId: fleet.route.routeId });
    expect(rename.status).toBe(200);
  });
});

describe('who can see a custom route', () => {
  let fleet;
  let publicRoute;
  let rider;
  let riderId;
  let outsider;

  beforeAll(async () => {
    publicRoute = await Route.create({
      routeId: `CR-VIS-PUB-${stamp}`, routeName: 'Public Visible', source: 'A', destination: 'B', distance: 10, fare: 50
    });
    fleet = await setupFleet();
    await recordRides(fleet, 5);

    rider = await createRider({ name: 'Enrolled Rider' });
    const created = await request(app).post('/api/riders').set(...authHeader(rider.token))
      .send({ fullName: 'Amaya', contactPhone: '0777654321' });
    riderId = created.body.data._id;
    outsider = await createRider({ name: 'Outside Rider' });
    await request(app).post('/api/riders').set(...authHeader(outsider.token))
      .send({ fullName: 'Nimal', contactPhone: '0777654322' });
  });

  const routeUrl = () => `/api/routes/${fleet.route.routeId}`;
  const pathUrl = () => `/api/vehicle/routes/${fleet.route.routeId}/path`;
  const vehiclesUrl = () => `/api/vehicle/route/${fleet.route.routeId}`;

  const enrol = () => DriverEnrollment.create({
    studentId: riderId, driverId: fleet.driver.id, managerId: fleet.manager.id, status: 'ACTIVE'
  });

  it('never appears in a public list, search, paginated list, stops or stats - at any status', async () => {
    const id = fleet.route.routeId;
    const hasId = (res) => JSON.stringify(res.body).includes(id);

    for (const status of ['RECORDING', 'PENDING_REVIEW', 'ACTIVE']) {
      // eslint-disable-next-line no-await-in-loop
      await Route.updateOne({ routeId: id }, { $set: { status, isActive: true } });
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all([
        request(app).get('/api/routes'),
        request(app).get('/api/routes?isActive=true'),
        request(app).get('/api/routes/paginated'),
        request(app).get('/api/vehicle/routes'),
        request(app).get('/api/vehicle/stops')
      ]);
      results.forEach((res) => expect(hasId(res)).toBe(false));
    }
    const stats = await request(app).get('/api/routes/stats/overview');
    const publicOnly = await Route.countDocuments({ isDeleted: false, origin: { $ne: 'RECORDED' } });
    expect(stats.body.data.totalRoutes).toBe(publicOnly);
    await Route.updateOne({ routeId: id }, { $set: { status: 'PENDING_REVIEW' } });
  });

  it('still lists ordinary public routes', async () => {
    const res = await request(app).get('/api/routes');
    expect(JSON.stringify(res.body)).toContain(publicRoute.routeId);
  });

  it('is a 404 for an anonymous caller on the route, its path, and its vehicles', async () => {
    expect((await request(app).get(routeUrl())).status).toBe(404);
    expect((await request(app).get(pathUrl())).status).toBe(404);
    const vehicles = await request(app).get(vehiclesUrl());
    expect(vehicles.body.data).toEqual([]);
  });

  it('is a 404 for a rider who is not enrolled on it', async () => {
    await Route.updateOne({ routeId: fleet.route.routeId }, { $set: { status: 'ACTIVE' } });
    expect((await request(app).get(routeUrl()).set(...authHeader(outsider.token))).status).toBe(404);
    expect((await request(app).get(pathUrl()).set(...authHeader(outsider.token))).status).toBe(404);
    await Route.updateOne({ routeId: fleet.route.routeId }, { $set: { status: 'PENDING_REVIEW' } });
  });

  it('is a 404 for another manager and another driver', async () => {
    const other = await setupFleet();
    expect((await request(app).get(routeUrl()).set(...other.asManager())).status).toBe(404);
    expect((await request(app).get(pathUrl()).set(...other.asDriver())).status).toBe(404);
  });

  it('is readable by its manager, its driver and a super-admin before it is live', async () => {
    const superAdmin = await createSuperAdmin({ name: 'Visibility Admin' });
    for (const as of [fleet.asManager(), fleet.asDriver(), authHeader(superAdmin.token)]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(pathUrl()).set(...as);
      expect(res.status).toBe(200);
      expect(res.body.data.coords.length).toBeGreaterThan(10);
      expect(res.body.data.source).toBe('recorded');
    }
  });

  it('hides the line from an enrolled rider until the manager confirms, then shows it', async () => {
    await enrol();
    // Waiting for review: the rider sees no route at all.
    expect((await request(app).get(pathUrl()).set(...authHeader(rider.token))).status).toBe(404);
    expect((await request(app).get(routeUrl()).set(...authHeader(rider.token))).status).toBe(404);

    await request(app).patch(`/api/manager/custom-routes/${fleet.route.routeId}/confirm`)
      .set(...fleet.asManager()).send({ routeName: 'Visible After Confirm' });

    const path = await request(app).get(pathUrl()).set(...authHeader(rider.token));
    expect(path.status).toBe(200);
    expect(path.body.data.coords.length).toBeGreaterThan(10);
    const route = await request(app).get(routeUrl()).set(...authHeader(rider.token));
    expect(route.status).toBe(200);
    expect(route.body.data.routeName).toBe('Visible After Confirm');
    // The vehicle on the route is visible to the enrolled rider as well.
    const vehicles = await request(app).get(vehiclesUrl()).set(...authHeader(rider.token));
    expect(vehicles.body.data).toHaveLength(1);

    // Still not to the outsider.
    expect((await request(app).get(pathUrl()).set(...authHeader(outsider.token))).status).toBe(404);
  });

  it('never puts a custom route in the shared path cache, and never calls Google for it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await request(app).get(pathUrl()).set(...fleet.asManager());
    expect(_pathCache.has(fleet.route.routeId)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns an empty line (not an error) for a manager whose route has none yet', async () => {
    const fresh = await setupFleet();
    const res = await request(app)
      .get(`/api/vehicle/routes/${fresh.route.routeId}/path`)
      .set(...fresh.asManager());
    expect(res.status).toBe(200);
    expect(res.body.data.coords).toEqual([]);
    expect(res.body.data.matched).toBe(false);
  });

  it('a stored polyline round-trips through the path endpoint', async () => {
    const m = await createManager({ name: 'Roundtrip' });
    const r = await createProvisionalRoute({ managerId: m.id });
    const coords = [{ lat: 6.9, lng: 79.85 }, { lat: 6.91, lng: 79.86 }, { lat: 6.92, lng: 79.87 }];
    await Route.updateOne({ routeId: r.routeId }, { $set: { pathPolyline: encodePolyline(coords) } });
    const res = await request(app).get(`/api/vehicle/routes/${r.routeId}/path`).set(...authHeader(m.token));
    expect(res.body.data.coords).toHaveLength(3);
    expect(res.body.data.coords[2].lat).toBeCloseTo(6.92, 4);
  });
});
