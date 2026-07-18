const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Route = require('../../src/models/Route');
const RouteMembership = require('../../src/models/RouteMembership');
const RouteJoinRequest = require('../../src/models/RouteJoinRequest');
const RouteKeyAttempt = require('../../src/models/RouteKeyAttempt');
const Notification = require('../../src/models/Notification');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Private Routes (room-key / PIN) feature — see PRIVATE_ROUTES_PLAN.md.
// Covers manager privacy/room-key management, passenger PIN verification
// (with and without approval), the enforcement matrix (§5.3), and revocation.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

let managerToken, managerId;
let otherManagerToken;
let riderToken, riderId;
let otherRiderToken, otherRiderId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const manager = await User.create({
    name: 'PR Manager', email: `pr-mgr-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  managerId = manager._id;
  managerToken = await loginAs(manager.email, 'P@ssw0rd!');

  const otherManager = await User.create({
    name: 'PR Other Manager', email: `pr-mgr2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'admin', isEmailVerified: true, isActive: true
  });
  otherManagerToken = await loginAs(otherManager.email, 'P@ssw0rd!');

  const rider = await User.create({
    name: 'PR Rider', email: `pr-rider-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  riderId = rider._id;
  riderToken = await loginAs(rider.email, 'P@ssw0rd!');

  const otherRider = await User.create({
    name: 'PR Other Rider', email: `pr-rider2-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  otherRiderId = otherRider._id;
  otherRiderToken = await loginAs(otherRider.email, 'P@ssw0rd!');
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

async function createOwnedRoute(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const route = await Route.create({
    routeId: `PR-${suffix}`.toUpperCase(),
    routeName: `Private Route ${suffix}`,
    source: 'Home',
    destination: 'Work',
    distance: 10,
    fare: 100,
    visibility: 'PUBLIC',
    managerId,
    stops: [{ stopName: 'Stop A', order: 1, lat: 1, lng: 1 }],
    pathPolyline: 'abc123',
    ...overrides
  });
  return route;
}

describe('Manager privacy management', () => {
  it('privatizes an owned route and auto-generates a room key', async () => {
    const route = await createOwnedRoute();

    const res = await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    expect(res.status).toBe(200);
    expect(res.body.data.visibility).toBe('PRIVATE');
    expect(res.body.data.hasRoomKey).toBe(true);

    const stored = await Route.findOne({ routeId: route.routeId });
    expect(stored.roomKey.lookupHash).toBeTruthy();
    expect(stored.roomKey.ciphertext).toBeTruthy();
  });

  it('rejects privatizing a route not owned by this manager (403)', async () => {
    const route = await createOwnedRoute();

    const res = await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${otherManagerToken}`)
      .send({ isPrivate: true });

    expect(res.status).toBe(403);
  });

  it('reveal/rotate are owner-only', async () => {
    const route = await createOwnedRoute({ visibility: 'PRIVATE' });
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const revealOther = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(revealOther.status).toBe(403);

    const rotateOther = await request(app)
      .post(`/api/manager/routes/${route.routeId}/room-key/rotate`)
      .set('Authorization', `Bearer ${otherManagerToken}`);
    expect(rotateOther.status).toBe(403);

    const revealOwner = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(revealOwner.status).toBe(200);
    expect(revealOwner.body.data.code).toMatch(/^\d{6}$/);

    const rotateOwner = await request(app)
      .post(`/api/manager/routes/${route.routeId}/room-key/rotate`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(rotateOwner.status).toBe(200);
    expect(rotateOwner.body.data.code).toMatch(/^\d{6}$/);
    expect(rotateOwner.body.data.code).not.toBe(revealOwner.body.data.code);
  });

  it('flipping PRIVATE back to PUBLIC clears flags and the room key', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true, isHidden: true, joinApprovalRequired: true });

    const res = await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: false });

    expect(res.status).toBe(200);
    expect(res.body.data.visibility).toBe('PUBLIC');
    expect(res.body.data.isHidden).toBe(false);
    expect(res.body.data.joinApprovalRequired).toBe(false);
    expect(res.body.data.hasRoomKey).toBe(false);

    const stored = await Route.findOne({ routeId: route.routeId });
    expect(stored.roomKey.lookupHash).toBeFalsy();
  });
});

describe('Passenger room-key verification', () => {
  it('grants ACTIVE membership on correct code (no approval)', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    const code = reveal.body.data.code;

    const res = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code });

    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe('GRANTED');

    const membership = await RouteMembership.findOne({ userId: riderId, routeId: route.routeId });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.grantedVia).toBe('PIN');
  });

  it('rejects a wrong code (403) and increments the attempt counter', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const res = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${otherRiderToken}`)
      .send({ routeId: route.routeId, code: '000000' });

    expect(res.status).toBe(403);
    const attempt = await RouteKeyAttempt.findOne({ userId: otherRiderId, routeId: route.routeId });
    expect(attempt.count).toBe(1);
  });

  it('locks out after ROOM_KEY_MAX_ATTEMPTS wrong attempts (429 with retryAfter)', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    let lastRes;
    for (let i = 0; i < 5; i += 1) {
      lastRes = await request(app)
        .post('/api/routes/join/verify')
        .set('Authorization', `Bearer ${otherRiderToken}`)
        .send({ routeId: route.routeId, code: '111111' });
    }
    expect(lastRes.status).toBe(403);
    expect(lastRes.body.retryAfter).toBeGreaterThan(0);

    const lockedRes = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${otherRiderToken}`)
      .send({ routeId: route.routeId, code: '111111' });
    expect(lockedRes.status).toBe(429);
    expect(lockedRes.body.retryAfter).toBeGreaterThan(0);
  });

  it('resolves a hidden route by manual code entry (no routeId given)', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true, isHidden: true });

    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    const code = reveal.body.data.code;

    const res = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe('GRANTED');
    expect(res.body.data.route.routeId).toBe(route.routeId);
  });
});

describe('PIN-then-approval flow', () => {
  it('correct code on an approval route creates exactly one PENDING request, not a membership', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true, joinApprovalRequired: true });

    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    const code = reveal.body.data.code;

    const res1 = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code });
    expect(res1.status).toBe(200);
    expect(res1.body.data.access).toBe('PENDING_APPROVAL');

    // Retry with the correct code again — must not create a second PENDING request.
    const res2 = await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code });
    expect(res2.status).toBe(200);
    expect(res2.body.data.access).toBe('PENDING_APPROVAL');

    const requests = await RouteJoinRequest.find({ userId: riderId, routeId: route.routeId });
    expect(requests.length).toBe(1);

    const membership = await RouteMembership.findOne({ userId: riderId, routeId: route.routeId });
    expect(membership).toBeNull();

    const managerNotif = await Notification.findOne({ userId: managerId, type: 'ROUTE_ACCESS_REQUEST' });
    expect(managerNotif).toBeTruthy();
  });

  it('manager approve grants membership + notifies; reject notifies with no membership', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true, joinApprovalRequired: true });
    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    const code = reveal.body.data.code;

    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code });
    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${otherRiderToken}`)
      .send({ routeId: route.routeId, code });

    const list = await request(app)
      .get(`/api/manager/routes/${route.routeId}/join-requests?status=PENDING`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(list.body.count).toBe(2);
    const riderRequest = list.body.data.find((r) => r.userId._id === String(riderId));
    const otherRequest = list.body.data.find((r) => r.userId._id === String(otherRiderId));

    const approveRes = await request(app)
      .patch(`/api/manager/join-requests/${riderRequest._id}/decision`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' });
    expect(approveRes.status).toBe(200);

    const membership = await RouteMembership.findOne({ userId: riderId, routeId: route.routeId });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.grantedVia).toBe('APPROVAL');
    const approvedNotif = await Notification.findOne({ userId: riderId, type: 'ROUTE_ACCESS_APPROVED' });
    expect(approvedNotif).toBeTruthy();

    // Double-approve is idempotent.
    const secondApprove = await request(app)
      .patch(`/api/manager/join-requests/${riderRequest._id}/decision`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'APPROVED' });
    expect(secondApprove.status).toBe(200);
    expect(secondApprove.body.message).toBe('Already decided');

    const rejectRes = await request(app)
      .patch(`/api/manager/join-requests/${otherRequest._id}/decision`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ decision: 'REJECTED' });
    expect(rejectRes.status).toBe(200);

    const otherMembership = await RouteMembership.findOne({ userId: otherRiderId, routeId: route.routeId });
    expect(otherMembership).toBeNull();
    const rejectedNotif = await Notification.findOne({ userId: otherRiderId, type: 'ROUTE_ACCESS_REJECTED' });
    expect(rejectedNotif).toBeTruthy();
  });
});

describe('Revocation', () => {
  it('manager can revoke an active member; membership flips to REVOKED and user is notified', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });
    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code: reveal.body.data.code });

    const revokeRes = await request(app)
      .delete(`/api/manager/routes/${route.routeId}/members/${riderId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(revokeRes.status).toBe(200);

    const membership = await RouteMembership.findOne({ userId: riderId, routeId: route.routeId });
    expect(membership.status).toBe('REVOKED');
    const revokedNotif = await Notification.findOne({ userId: riderId, type: 'ROUTE_ACCESS_REVOKED' });
    expect(revokedNotif).toBeTruthy();
  });
});

describe('Enforcement matrix — listing, detail, bus, ETA', () => {
  it('getAllRoutes includes an unhidden PRIVATE route as a locked stub with no stops', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const res = await request(app).get('/api/routes');
    const found = res.body.data.find((r) => r.routeId === route.routeId);
    expect(found).toBeTruthy();
    expect(found.locked).toBe(true);
    expect(found.isPrivate).toBe(true);
    expect(found.stops).toBeUndefined();
  });

  it('getAllRoutes never lists a hidden PRIVATE route', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true, isHidden: true });

    const res = await request(app).get('/api/routes');
    const found = res.body.data.find((r) => r.routeId === route.routeId);
    expect(found).toBeUndefined();
  });

  it('getRouteById (unauthenticated detail) 404s for a PRIVATE route regardless of membership', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const res = await request(app).get(`/api/routes/${route.routeId}`);
    expect(res.status).toBe(404);
  });

  it('bus/route/:routeId returns empty for a non-member, populated for an ACTIVE member', async () => {
    const Bus = require('../../src/models/Bus');
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });
    await Bus.create({
      busId: `BUS-${route.routeId}`, busName: 'Shuttle', numberPlate: `PLT-${route.routeId}`,
      registrationNumber: `REG-${route.routeId}`, routeId: route.routeId, seatCapacity: 20,
      driverId: managerId, managerId
    });

    const nonMemberRes = await request(app).get(`/api/bus/route/${route.routeId}`);
    expect(nonMemberRes.status).toBe(200);
    expect(nonMemberRes.body.data.length).toBe(0);

    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code: reveal.body.data.code });

    const memberRes = await request(app)
      .get(`/api/bus/route/${route.routeId}`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(memberRes.status).toBe(200);
    expect(memberRes.body.data.length).toBe(1);
  });

  it('eta/route/:routeId/all-buses is 403 for a non-member and 200 for an ACTIVE member', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });

    const forbidden = await request(app)
      .get(`/api/eta/route/${route.routeId}/all-buses`)
      .set('Authorization', `Bearer ${otherRiderToken}`);
    expect(forbidden.status).toBe(403);

    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code: reveal.body.data.code });

    const allowed = await request(app)
      .get(`/api/eta/route/${route.routeId}/all-buses`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(allowed.status).toBe(200);
  });
});

describe('My Private Routes / my-requests', () => {
  it('lists the ACTIVE-membership routes and pending requests for the current user', async () => {
    const route = await createOwnedRoute();
    await request(app)
      .patch(`/api/manager/routes/${route.routeId}/privacy`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isPrivate: true });
    const reveal = await request(app)
      .get(`/api/manager/routes/${route.routeId}/room-key`)
      .set('Authorization', `Bearer ${managerToken}`);
    await request(app)
      .post('/api/routes/join/verify')
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ routeId: route.routeId, code: reveal.body.data.code });

    const myPrivate = await request(app)
      .get('/api/routes/my-private')
      .set('Authorization', `Bearer ${riderToken}`);
    expect(myPrivate.body.data.some((r) => r.routeId === route.routeId)).toBe(true);

    const leaveRes = await request(app)
      .delete(`/api/routes/${route.routeId}/membership`)
      .set('Authorization', `Bearer ${riderToken}`);
    expect(leaveRes.status).toBe(200);

    const myPrivateAfter = await request(app)
      .get('/api/routes/my-private')
      .set('Authorization', `Bearer ${riderToken}`);
    expect(myPrivateAfter.body.data.some((r) => r.routeId === route.routeId)).toBe(false);
  });
});
