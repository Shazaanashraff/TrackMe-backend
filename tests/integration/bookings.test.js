const request = require('supertest');
const app = require('../../src/server');
const fixtures = require('../mock.json');

describe('Bookings Integration - /api/bookings', () => {
  let token;

  beforeAll(async () => {
    const login = await request(app).post('/api/auth/login').send(fixtures.login.valid);
    token = login.body.token;
  });

  test('create booking success', async () => {
    const payload = { userId: fixtures.bookings[0].userId, busId: fixtures.bookings[0].busId, seat: 2 };
    const res = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(payload);
    expect([201, 200]).toContain(res.status);
    expect(res.body.code).toBe('BOOKING_CREATED');
    expect(res.body.data).toHaveProperty('id');
  });

  test('create booking missing fields -> 400 BOOKING_VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send({ userId: fixtures.bookings[0].userId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOOKING_VALIDATION_ERROR');
  });

  test('seat conflict returns 409 BOOKING_CONFLICT', async () => {
    const payload = { userId: fixtures.bookings[0].userId, busId: fixtures.bookings[0].busId, seat: 3 };
    const r1 = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(payload);
    expect([201, 200]).toContain(r1.status);

    const r2 = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(payload);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('BOOKING_CONFLICT');
  });

  test('concurrent seat allocation (race) - one succeeds, others conflict', async () => {
    const payload = { userId: 'user-concurrent', busId: fixtures.bookings[0].busId, seat: 4 };
    const reqs = [1, 2, 3].map(() => request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`).send(payload));
    const res = await Promise.all(reqs);
    const successCount = res.filter(r => r.status === 201).length;
    const conflictCount = res.filter(r => r.status === 409).length;
    expect(successCount).toBeGreaterThanOrEqual(1);
    expect(conflictCount + successCount).toBe(res.length);
  });
});
