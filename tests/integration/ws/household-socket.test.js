const { io: ioClient } = require('socket.io-client');

jest.setTimeout(30000);
const { server } = require('../../../src/server');
const app = require('../../../src/server');
const User = require('../../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('../db');
const { createRider } = require('../factories');

// qr-attendance-socket.test.js locks the single-user auto-join. This covers
// what changes under multiple rider profiles: a connection made with the
// PRIMARY's token must also auto-join every managed profile's
// `student:<id>` room, so an attendance event for a switched-out child still
// reaches whichever session happens to be connected — see
// docs/modules/PROFILES.md and socket/socketHandler.js.

let primaryClient;
let primary;
let child;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await new Promise((resolve) => server.listen(0, () => resolve()));
  const port = server.address().port;

  primary = await createRider({ name: 'Parent' });
  child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });

  primaryClient = await new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, {
      auth: { token: primary.token }, transports: ['websocket']
    });
    c.on('connection-success', () => resolve(c));
    c.on('connect_error', reject);
  });
});

afterAll(async () => {
  primaryClient?.disconnect();
  await clearTestDb();
  await closeTestDb();
  await new Promise((resolve) => server.close(resolve));
});

describe('household auto-join on connect', () => {
  it("a connection made with the primary's token also receives events for a managed child's room", async () => {
    const received = new Promise((resolve) => {
      primaryClient.once('attendance:event', resolve);
    });

    app.get('io').to(`student:${child._id}`).emit('attendance:event', {
      studentId: String(child._id),
      type: 'BOARD'
    });

    const event = await received;
    expect(event.studentId).toBe(String(child._id));
  });

  it("still receives events for its own room too", async () => {
    const received = new Promise((resolve) => {
      primaryClient.once('attendance:event', resolve);
    });

    app.get('io').to(`student:${primary.id}`).emit('attendance:event', {
      studentId: String(primary.id),
      type: 'ALIGHT'
    });

    const event = await received;
    expect(event.studentId).toBe(String(primary.id));
  });
});
