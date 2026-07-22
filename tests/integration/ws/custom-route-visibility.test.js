const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const User = require('../../../src/models/User');
const Route = require('../../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');

// A manager's PRIVATE custom route must never be joinable or leak live
// locations via sockets — this covers the join-route and
// route:get-recent-locations guards added in socketHandler.js.
//
// A single persistent connection is reused across all cases (rather than
// reconnecting per test) — each fresh handshake is a real network round trip
// and the extra churn made this suite flaky under sandboxed loopback networking.

let client;

const emitAsync = (event, payload) =>
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

  const rider = await User.create({
    name: 'Rider',
    email: `rider-${Date.now()}@test.com`,
    password: 'Test@1234',
    role: 'user',
    isEmailVerified: true,
    isActive: true
  });
  const riderToken = jwt.sign({ id: rider._id, role: 'user' }, process.env.JWT_SECRET || 'test-secret');

  await Route.create([
    {
      routeId: 'WS-PUBLIC-1',
      routeName: 'Public WS Route',
      source: 'A',
      destination: 'B',
      distance: 5,
      fare: 50,
      visibility: 'PUBLIC'
    },
    {
      routeId: 'WS-PRIVATE-1',
      routeName: 'Custom Route (Pending)',
      source: 'Custom Route',
      destination: 'Custom Route',
      distance: 0,
      fare: 0,
      visibility: 'PRIVATE',
      origin: 'RECORDED',
      status: 'PENDING_NAMING'
    }
  ]);

  client = await new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { auth: { token: riderToken }, transports: ['websocket'] });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
});

afterAll(async () => {
  client?.disconnect();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

describe('join-route visibility', () => {
  it('allows joining a PUBLIC route', async () => {
    const res = await emitAsync('join-route', { routeId: 'WS-PUBLIC-1' });
    expect(res.success).toBe(true);
  });

  it('rejects joining a PRIVATE custom route', async () => {
    const res = await emitAsync('join-route', { routeId: 'WS-PRIVATE-1' });
    expect(res.success).toBe(false);
  });
});

describe('route:get-recent-locations visibility', () => {
  it('rejects fetching recent locations for a PRIVATE custom route', async () => {
    const res = await emitAsync('route:get-recent-locations', { routeId: 'WS-PRIVATE-1' });
    expect(res.success).toBe(false);
  });

  it('allows fetching recent locations for a PUBLIC route', async () => {
    const res = await emitAsync('route:get-recent-locations', { routeId: 'WS-PUBLIC-1' });
    expect(res.success).toBe(true);
  });
});
