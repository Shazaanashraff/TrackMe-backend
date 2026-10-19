const net = require('net');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { ipKeyGenerator } = rateLimit;

// IP-based rate limiting, complementary to the per-identity limiters in
// emailRateLimiter.js (those key on email/identifier, so they don't stop one
// client from hammering many different accounts or endpoints).

// The caller's address. Behind Render, req.ip is a Cloudflare/Render proxy
// address even with app.set('trust proxy', 1): one phone was counted in
// several rotating buckets, and every rider reaching the same Cloudflare edge
// shared them. Cloudflare writes CF-Connecting-IP on every request that
// reaches a Render web service and refuses a request that sends its own copy
// (403, error 1000), so on Render that header is the real client. Locally and
// in tests there is no Cloudflare, so it falls back to req.ip.
const clientIp = (req) => {
  const header = req.headers['cf-connecting-ip'];
  const value = typeof header === 'string' ? header.trim() : '';
  return net.isIP(value) ? value : req.ip;
};

const ipKey = (req) => `ip:${ipKeyGenerator(clientIp(req))}`;

// The signed-in account behind a request, from a verified access token, or
// null. Verified, not decoded, so a forged token cannot pick its bucket; a
// refresh token is no access token (same rule as `protect`).
const accountKey = (req) => {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.tokenType === 'refresh' || !decoded.id) return null;
    return `account:${decoded.role}:${decoded.id}`;
  } catch {
    return null;
  }
};

// Auth surface (login, register, OTP, refresh, etc.) — generous enough for a
// real user's retries, tight enough to blunt IP-level brute forcing/scraping
// across accounts. Keyed by client address only: the point is one source
// trying many accounts.
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_IP_RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { success: false, message: 'Too many requests. Please wait before trying again.' }
});

// General API surface — a much higher ceiling, just a backstop against
// runaway/abusive clients rather than a throttle real usage could hit. A
// signed-in request counts against its account, so phones sharing one Wi-Fi
// (one address) no longer share an allowance, and one runaway phone cannot
// lock out other riders; anything else counts against its address.
const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => accountKey(req) || ipKey(req),
  message: { success: false, message: 'Too many requests. Please wait before trying again.' }
});

module.exports = { authLimiter, apiLimiter };
