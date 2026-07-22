const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const app = require('../../../src/server');
const User = require('../../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');

// Every authenticated socket auto-joins `student:<userId>` on connect (see
// docs/features/qr-attendance/QR_SYSTEM.md) — this is what lets the boarding
// scan endpoint's `io.to('student:<id>').emit('attendance:event', ...)` actually
// reach the rider's own device, with no explicit client-side "join" step needed.

let riderClient;
let riderId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });
  const port = server.address().port;

  const rider = await User.create({
    name: 'QR Socket Rider', email: `ws-qr-rider-${Date.now()}@test.com`, password: 'Test@1234',
    role: 'user', isEmailVerified: true, isActive: true
  });
  riderId = rider._id;
  const riderToken = jwt.sign({ id: rider._id, role: 'user' }, process.env.JWT_SECRET || 'test-secret');

  riderClient = await new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { auth: { token: riderToken }, transports: ['websocket'] });
    // Wait for `connection-success`, not just the transport-level `connect` — it's
    // emitted only after the server has finished auto-joining `student:<userId>`,
    // so it's the correct readiness signal for this test.
    c.on('connection-success', () => resolve(c));
    c.on('connect_error', reject);
  });
});

afterAll(async () => {
  riderClient?.disconnect();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

describe('student:<userId> auto-join', () => {
  it('receives an attendance:event emitted to their own student room with no explicit join', async () => {
    const received = new Promise((resolve) => {
      riderClient.once('attendance:event', resolve);
    });

    app.get('io').to(`student:${riderId}`).emit('attendance:event', {
      studentId: String(riderId),
      type: 'BOARD'
    });

    const event = await received;
    expect(event.studentId).toBe(String(riderId));
    expect(event.type).toBe('BOARD');
  });
});
