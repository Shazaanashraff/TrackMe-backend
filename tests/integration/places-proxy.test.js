const request = require('supertest');
const app = require('../../src/server');

// These tests exercise the Places proxy's guards WITHOUT calling Google:
// short input is short-circuited, missing placeId is rejected, and a missing
// server key returns 503. None of these paths reach places.googleapis.com.
describe('Places proxy guards (no upstream calls)', () => {
  it('returns an empty list for short input without calling Google', async () => {
    const res = await request(app).get('/api/places/autocomplete?input=a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 0, data: [] });
  });

  it('rejects place details with no placeId', async () => {
    const res = await request(app).get('/api/places/details');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 503 when the server key is not configured', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    delete process.env.GOOGLE_PLACES_KEY;
    try {
      const res = await request(app).get('/api/places/autocomplete?input=colombo');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    } finally {
      if (original !== undefined) process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('never leaks the key in a response body', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'SECRET-TEST-KEY-123';
    try {
      const res = await request(app).get('/api/places/autocomplete?input=x'); // short -> no upstream
      expect(JSON.stringify(res.body)).not.toContain('SECRET-TEST-KEY-123');
    } finally {
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });
});
