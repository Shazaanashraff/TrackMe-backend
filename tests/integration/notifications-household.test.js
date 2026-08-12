const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, authHeader } = require('./factories');

// notifications.test.js locks single-caller ownership and the manager-only
// cleanup endpoint. This covers what changes under multiple rider profiles:
// reads are household-scoped (a notification about child B must stay visible
// while profile A's session is active), narrowable via ?profileId=, and a
// device token registered while a managed profile is active always lands on
// the account holder.

let primary;
let primaryAuth;
let child;
let childAuth;

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  primary = await createRider({ name: 'Parent' });
  primaryAuth = authHeader(primary.token);

  child = await User.create({ name: 'Child', identityId: primary.identity._id, profileKind: 'MANAGED' });
  const switchRes = await request(app).post(`/api/profiles/${child._id}/switch`).set(...primaryAuth);
  childAuth = authHeader(switchRes.body.accessToken);
});

const makeNotification = (userId, overrides = {}) =>
  Notification.create({
    userId, type: 'SYSTEM_ALERT', title: 'Test', message: 'Test message', ...overrides
  });

describe('GET /api/notifications — household scoping', () => {
  it("a notification about the child is visible from the parent's own session", async () => {
    await makeNotification(child._id, { title: 'Child boarded' });

    const res = await request(app).get('/api/notifications').set(...primaryAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((n) => n.title)).toContain('Child boarded');
  });

  it('the household includes notifications for every profile, combined', async () => {
    await makeNotification(primary.id, { title: 'For parent' });
    await makeNotification(child._id, { title: 'For child' });

    const res = await request(app).get('/api/notifications').set(...primaryAuth);
    expect(res.body.data.map((n) => n.title).sort()).toEqual(['For child', 'For parent']);
  });

  it('?profileId= narrows to just that profile', async () => {
    await makeNotification(primary.id, { title: 'For parent' });
    await makeNotification(child._id, { title: 'For child' });

    const res = await request(app)
      .get('/api/notifications')
      .query({ profileId: String(child._id) })
      .set(...primaryAuth);

    expect(res.body.data.map((n) => n.title)).toEqual(['For child']);
  });

  it("?profileId= for a profile outside the caller's household returns nothing, not an error", async () => {
    const stranger = await createRider({ name: 'Stranger' });
    await makeNotification(stranger.id, { title: 'Not yours' });

    const res = await request(app)
      .get('/api/notifications')
      .query({ profileId: stranger.id })
      .set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('a notification is visible and actionable from the child\'s own switched-in session too', async () => {
    await makeNotification(primary.id, { title: 'For parent' });

    const res = await request(app).get('/api/notifications').set(...childAuth);
    expect(res.body.data.map((n) => n.title)).toContain('For parent');
  });
});

describe('GET /api/notifications/count/unread — household scoping', () => {
  it('counts unread notifications across the whole household', async () => {
    await makeNotification(primary.id);
    await makeNotification(child._id);
    await makeNotification(child._id, { isRead: true });

    const res = await request(app).get('/api/notifications/count/unread').set(...primaryAuth);
    expect(res.body.unreadCount).toBe(2);
  });
});

describe('PUT /api/notifications/:id/read — household scoping', () => {
  it("the parent's session can mark the child's notification as read", async () => {
    const notification = await makeNotification(child._id);

    const res = await request(app)
      .put(`/api/notifications/${notification._id}/read`)
      .set(...primaryAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
  });

  it('still 404s for a notification outside the household', async () => {
    const stranger = await createRider({ name: 'Stranger' });
    const notification = await makeNotification(stranger.id);

    const res = await request(app)
      .put(`/api/notifications/${notification._id}/read`)
      .set(...primaryAuth);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/notifications/device-token while a managed profile is active', () => {
  it("registers the token on the account holder's profile, not the switched-in child", async () => {
    const res = await request(app)
      .post('/api/notifications/device-token')
      .set(...childAuth)
      .send({ token: 'ExponentPushToken[from-child-session]' });

    expect(res.status).toBe(200);

    const storedParent = await User.findById(primary.id);
    const storedChild = await User.findById(child._id);
    expect(storedParent.pushTokens).toContain('ExponentPushToken[from-child-session]');
    expect(storedChild.pushTokens).not.toContain('ExponentPushToken[from-child-session]');
  });

  it("registering from the parent's own session still lands on the parent, as before", async () => {
    const res = await request(app)
      .post('/api/notifications/device-token')
      .set(...primaryAuth)
      .send({ token: 'ExponentPushToken[from-parent-session]' });

    expect(res.status).toBe(200);
    const stored = await User.findById(primary.id);
    expect(stored.pushTokens).toContain('ExponentPushToken[from-parent-session]');
  });
});
