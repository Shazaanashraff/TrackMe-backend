const { createEmailRateLimiter } = require('../../src/middleware/emailRateLimiter');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('createEmailRateLimiter', () => {
  test('defaults to keying by req.body.email', () => {
    const limiter = createEmailRateLimiter({ windowMs: 10000, max: 1, message: 'blocked' });

    const req = { body: { email: 'a@t.com' } };
    const res1 = mockRes();
    limiter(req, res1, jest.fn());
    expect(res1.status).not.toHaveBeenCalled();

    const res2 = mockRes();
    limiter(req, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  test('an empty key skips rate limiting entirely', () => {
    const limiter = createEmailRateLimiter({ windowMs: 10000, max: 1, message: 'blocked' });
    const next = jest.fn();

    limiter({ body: {} }, mockRes(), next);
    limiter({ body: {} }, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  // Issue #35: login accepts an `identifier` (email or driver code), not just
  // `email`, so it needs its own key extractor rather than the default.
  test('a custom keyExtractor buckets independently of req.body.email', () => {
    const limiter = createEmailRateLimiter({
      windowMs: 10000,
      max: 1,
      message: 'blocked',
      keyExtractor: (req) => String(req.body?.identifier || '').toLowerCase()
    });

    const driverReq = { body: { identifier: 'DRV-ABCD-1234' } };
    const emailReq = { body: { identifier: 'a@t.com' } };

    limiter(driverReq, mockRes(), jest.fn());
    limiter(emailReq, mockRes(), jest.fn());

    // Both are fresh buckets under the custom key, so neither is blocked yet.
    const res1 = mockRes();
    limiter(emailReq, res1, jest.fn());
    expect(res1.status).toHaveBeenCalledWith(429);

    const res2 = mockRes();
    limiter(driverReq, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  test('the bucket resets once the window elapses', async () => {
    const limiter = createEmailRateLimiter({ windowMs: 50, max: 1, message: 'blocked' });
    const req = { body: { email: 'a@t.com' } };

    limiter(req, mockRes(), jest.fn());

    const blocked = mockRes();
    limiter(req, blocked, jest.fn());
    expect(blocked.status).toHaveBeenCalledWith(429);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const afterWindow = mockRes();
    const next = jest.fn();
    limiter(req, afterWindow, next);
    expect(next).toHaveBeenCalled();
    expect(afterWindow.status).not.toHaveBeenCalled();
  });
});
