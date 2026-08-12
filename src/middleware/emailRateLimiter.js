const defaultKeyExtractor = (req) => String(req.body?.email || '').trim().toLowerCase();

// Fixed-window rate limiter keyed by the normalized email in req.body.email
// (or by keyExtractor, when a caller needs a different request field —
// e.g. login's `identifier`, which accepts a driver code as well as an
// email). In-memory only (single-instance deployment, same pattern as other
// in-memory bookkeeping in this service) — not shared across processes.
function createEmailRateLimiter({ windowMs, max, message, keyExtractor = defaultKeyExtractor }) {
  const buckets = new Map();

  return (req, res, next) => {
    const email = keyExtractor(req);
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
