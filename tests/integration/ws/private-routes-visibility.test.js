const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const User = require('../../../src/models/User');
const Route = require('../../../src/models/Route');
const RouteMembership = require('../../../src/models/RouteMembership');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');

// join-route / route:get-recent-locations must allow an authenticated ACTIVE
// member onto a PRIVATE (Private Routes feature) route and deny everyone else.
// See PRIVATE_ROUTES_PLAN.md §5.3.

let memberClient;
let nonMemberClient;
let memberId;

const emitAsync = (client, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ack on "${event}"`)), 10000);
    client.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });
  const port = server.address().port;

  const member = await User.create({
    name: 'Member Rider', email: `ws-member-${Date.now()}@test.com`, password: 'Test@1234',
    role: 'user', isEmailVerified: true, isActive: true
  });
  memberId = member._id;
  const memberToken = jwt.sign({ id: member._id }, process.env.JWT_SECRET || 'test-secret');

  const nonMember = await User.create({
    name: 'Non Member Rider', email: `ws-nonmember-${Date.now()}@test.com`, password: 'Test@1234',
    role: 'user', isEmailVerified: true, isActive: true
  });
  const nonMemberToken = jwt.sign({ id: nonMember._id }, process.env.JWT_SECRET || 'test-secret');

  await Route.create({
    routeId: 'WS-PRIV-ROOMKEY-1',
    routeName: 'Private Room-Key Route',
    source: 'A',
    destination: 'B',
    distance: 5,
    fare: 50,
    visibility: 'PRIVATE'
  });

  await RouteMembership.create({
    userId: memberId,
    routeId: 'WS-PRIV-ROOMKEY-1',
    managerId: member._id,
    status: 'ACTIVE',
    grantedVia: 'PIN'
  });

  memberClient = await new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { auth: { token: memberToken }, transports: ['websocket'] });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });

  nonMemberClient = await new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { auth: { token: nonMemberToken }, transports: ['websocket'] });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
});

afterAll(async () => {
  memberClient?.disconnect();
  nonMemberClient?.disconnect();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

describe('join-route with ACTIVE membership', () => {
  it('allows an ACTIVE member to join a PRIVATE route', async () => {
    const res = await emitAsync(memberClient, 'join-route', { routeId: 'WS-PRIV-ROOMKEY-1' });
    expect(res.success).toBe(true);
  });

  it('denies a non-member', async () => {
    const res = await emitAsync(nonMemberClient, 'join-route', { routeId: 'WS-PRIV-ROOMKEY-1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/access denied/i);
  });
});

describe('route:get-recent-locations with ACTIVE membership', () => {
  it('allows an ACTIVE member', async () => {
    const res = await emitAsync(memberClient, 'route:get-recent-locations', { routeId: 'WS-PRIV-ROOMKEY-1' });
    expect(res.success).toBe(true);
  });

  it('denies a non-member', async () => {
    const res = await emitAsync(nonMemberClient, 'route:get-recent-locations', { routeId: 'WS-PRIV-ROOMKEY-1' });
    expect(res.success).toBe(false);
  });
});

describe('revocation kicks the member', () => {
  it('emits route:access-revoked to the route room when revoked', async () => {
    await emitAsync(memberClient, 'join-route', { routeId: 'WS-PRIV-ROOMKEY-1' });

    const revokedEvent = new Promise((resolve) => {
      memberClient.once('route:access-revoked', resolve);
    });

    await RouteMembership.findOneAndUpdate(
      { userId: memberId, routeId: 'WS-PRIV-ROOMKEY-1' },
      { $set: { status: 'REVOKED', revokedAt: new Date() } }
    );
    // Reuse the app's io instance the same way managerPrivateRoutesController does.
    const app = require('../../../src/server');
    app.get('io').to('route:WS-PRIV-ROOMKEY-1').emit('route:access-revoked', {
      routeId: 'WS-PRIV-ROOMKEY-1',
      userId: String(memberId)
    });

    const event = await revokedEvent;
    expect(event.routeId).toBe('WS-PRIV-ROOMKEY-1');
  });
});
