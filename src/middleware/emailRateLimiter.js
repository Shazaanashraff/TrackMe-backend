// Fixed-window rate limiter keyed by the normalized email in req.body.email.
// In-memory only (single-instance deployment, same pattern as other in-memory
// bookkeeping in this service) — not shared across processes.
function createEmailRateLimiter({ windowMs, max, message }) {
  const buckets = new Map();

  return (req, res, next) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return next();

    const now = Date.now();
    const bucket = buckets.get(email);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(email, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      return res.status(429).json({ success: false, message });
    }

    bucket.count += 1;
    return next();
  };
}

module.exports = { createEmailRateLimiter };
