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
