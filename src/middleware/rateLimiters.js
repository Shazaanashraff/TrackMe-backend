const rateLimit = require('express-rate-limit');

// IP-based rate limiting, complementary to the per-identity limiters in
// emailRateLimiter.js (those key on email/identifier, so they don't stop one
// client from hammering many different accounts or endpoints). Requires
// app.set('trust proxy', ...) in server.js — Render sits behind a proxy, so
// without it every request appears to share one IP and this misfires.

// Auth surface (login, register, OTP, refresh, etc.) — generous enough for a
// real user's retries, tight enough to blunt IP-level brute forcing/scraping
// across accounts.
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_IP_RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait before trying again.' }
});

// General API surface — a much higher ceiling, just a backstop against
// runaway/abusive clients rather than a throttle real usage could hit.
const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait before trying again.' }
});

module.exports = { authLimiter, apiLimiter };
