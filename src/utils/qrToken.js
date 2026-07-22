// Rotating signed QR token utils — see docs/features/qr-attendance/QR_SYSTEM.md.
// Signed with a DEDICATED secret (QR_JWT_SECRET), never the auth JWT_SECRET, so a leaked
// QR token can never be replayed as (or forged into) an auth session token.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

const QR_JWT_SECRET = process.env.QR_JWT_SECRET;
// Moderate TTL — finalized default per todos/active/001-qr-attendance-foundation.md
// "Blocked — finalize during implementation" section. Overridable for ops tuning.
const QR_TOKEN_TTL = process.env.QR_TOKEN_TTL || '24h';

function requireSecret() {
  if (!QR_JWT_SECRET) {
    throw new Error('QR_JWT_SECRET is not configured');
  }
  return QR_JWT_SECRET;
}

// Signs a fresh QR token for a rider's account. Payload shape is part of the documented
// cross-repo contract: { sub: userId, ver, jti }. The token is account-scoped — it is not
// tied to any particular route, so one pass is valid everywhere the rider boards.
function signQr(user) {
  const secret = requireSecret();
  const payload = {
    sub: String(user._id),
    ver: user.qrTokenVersion,
    jti: crypto.randomUUID()
  };
  const token = jwt.sign(payload, secret, { expiresIn: QR_TOKEN_TTL });
  return { token, payload };
}

// Verifies a QR token: signature + expiry (via jwt.verify), then re-checks the user
// account is still active and that `ver` matches the account's current qrTokenVersion
// (instant revocation on rotate). Never throws — always resolves to a
// { valid, reason?, decoded?, user? } result so callers can respond cleanly.
async function verifyQr(token) {
  const secret = requireSecret();
  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { valid: false, reason: 'EXPIRED' };
    }
    return { valid: false, reason: 'INVALID' };
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive) {
    return { valid: false, reason: 'USER_NOT_FOUND', decoded };
  }

  if (user.qrTokenVersion !== decoded.ver) {
    return { valid: false, reason: 'STALE_VERSION', decoded, user };
  }

  return { valid: true, decoded, user };
}

module.exports = { signQr, verifyQr, QR_TOKEN_TTL };
