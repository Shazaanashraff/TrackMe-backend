const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers /api/notifications ownership checks (IDOR regression — see issue #1):
// getNotificationById, markAsRead, and deleteNotification must scope by the
// caller's userId, not just the notification's existence.

const USER_A = { email: `notif-a-${Date.now()}@test.com`, password: 'P@ssw0rd!' };
const USER_B = { email: `notif-b-${Date.now()}@test.com`, password: 'P@ssw0rd!' };

let tokenA, tokenB;
let userAId, userBId;
let notifA, notifB;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const userA = await User.create({
    name: 'Notif User A', email: USER_A.email, password: USER_A.password,
    role: 'user', isEmailVerified: true, isActive: true
  });
  userAId = userA._id;
  const loginA = await request(app).post('/api/auth/login').send(USER_A);
  tokenA = loginA.body.accessToken;

  const userB = await User.create({
    name: 'Notif User B', email: USER_B.email, password: USER_B.password,
    role: 'user', isEmailVerified: true, isActive: true
  });
  userBId = userB._id;
  const loginB = await request(app).post('/api/auth/login').send(USER_B);
  tokenB = loginB.body.accessToken;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  notifA = await Notification.create({
    userId: userAId, type: 'SYSTEM_ALERT', title: 'A title', message: 'A message'
  });
  notifB = await Notification.create({
    userId: userBId, type: 'SYSTEM_ALERT', title: 'B title', message: 'B message'
  });
});

describe('Notifications ownership (IDOR)', () => {
  it('GET /api/notifications/:id returns 404 for another user\'s notification', async () => {
    const res = await request(app)
      .get(`/api/notifications/${notifB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/notifications/:id returns the caller\'s own notification', async () => {
    const res = await request(app)
      .get(`/api/notifications/${notifA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(String(notifA._id));
  });

  it('PUT /api/notifications/:id/read returns 404 and does not mutate another user\'s notification', async () => {
    const res = await request(app)
      .put(`/api/notifications/${notifB._id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);

    const stored = await Notification.findById(notifB._id);
    expect(stored.isRead).toBe(false);
  });

  it('PUT /api/notifications/:id/read marks the caller\'s own notification as read', async () => {
    const res = await request(app)
      .put(`/api/notifications/${notifA._id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
  });

  it('DELETE /api/notifications/:id returns 404 and does not delete another user\'s notification', async () => {
    const res = await request(app)
      .delete(`/api/notifications/${notifB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);

    const stored = await Notification.findById(notifB._id);
    expect(stored).not.toBeNull();
  });

  it('DELETE /api/notifications/:id deletes the caller\'s own notification', async () => {
    const res = await request(app)
      .delete(`/api/notifications/${notifA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    const stored = await Notification.findById(notifA._id);
    expect(stored).toBeNull();
  });
});

describe('GET /api/notifications/count/unread', () => {
  // Dedicated users (rather than USER_A/USER_B above) so this block's counts
  // aren't affected by notifications the IDOR tests above already read/deleted.
  it('returns 0 when the caller has no unread notifications', async () => {
    const email = `notif-unread-empty-${Date.now()}@test.com`;
    await User.create({
      name: 'No Unread User', email, password: 'P@ssw0rd!',
      role: 'user', isEmailVerified: true, isActive: true
    });
    const login = await request(app).post('/api/auth/login').send({ email, password: 'P@ssw0rd!' });

    const res = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('is scoped to the caller — does not count another user\'s unread notifications', async () => {
    const emailX = `notif-unread-x-${Date.now()}@test.com`;
    const emailY = `notif-unread-y-${Date.now()}@test.com`;
    const userX = await User.create({
      name: 'Unread User X', email: emailX, password: 'P@ssw0rd!',
      role: 'user', isEmailVerified: true, isActive: true
    });
    const userY = await User.create({
      name: 'Unread User Y', email: emailY, password: 'P@ssw0rd!',
      role: 'user', isEmailVerified: true, isActive: true
    });
    const loginX = await request(app).post('/api/auth/login').send({ email: emailX, password: 'P@ssw0rd!' });
    const loginY = await request(app).post('/api/auth/login').send({ email: emailY, password: 'P@ssw0rd!' });

    await Notification.create([
      { userId: userX._id, type: 'SYSTEM_ALERT', title: 'X1', message: 'm', isRead: false },
      { userId: userX._id, type: 'SYSTEM_ALERT', title: 'X2', message: 'm', isRead: false },
      { userId: userX._id, type: 'SYSTEM_ALERT', title: 'X3 (read)', message: 'm', isRead: true },
      { userId: userY._id, type: 'SYSTEM_ALERT', title: 'Y1', message: 'm', isRead: false }
    ]);

    const resX = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${loginX.body.accessToken}`);
    expect(resX.status).toBe(200);
    expect(resX.body.unreadCount).toBe(2);

    const resY = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${loginY.body.accessToken}`);
    expect(resY.status).toBe(200);
    expect(resY.body.unreadCount).toBe(1);
  });
});
