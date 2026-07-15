// Rotating signed QR token utils — see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
// Signed with a DEDICATED secret (QR_JWT_SECRET), never the auth JWT_SECRET, so a leaked
// QR token can never be replayed as (or forged into) an auth session token.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const RouteMembership = require('../models/RouteMembership');

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

// Signs a fresh QR token for a membership. Payload shape is part of the documented
// cross-repo contract: { sub: membershipId, stu: studentId, rt: routeId, ver, jti }.
function signQr(membership) {
  const secret = requireSecret();
  const payload = {
    sub: String(membership._id),
    stu: String(membership.userId),
    rt: membership.routeId,
    ver: membership.tokenVersion,
    jti: crypto.randomUUID()
  };
  const token = jwt.sign(payload, secret, { expiresIn: QR_TOKEN_TTL });
  return { token, payload };
}

// Verifies a QR token: signature + expiry (via jwt.verify), then re-checks the
// membership is still ACTIVE and that `ver` matches the membership's current
// tokenVersion (instant revocation on rotate). Never throws — always resolves to
// a { valid, reason? , decoded?, membership? } result so callers can respond cleanly.
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

  const membership = await RouteMembership.findById(decoded.sub);
  if (!membership || membership.status !== 'ACTIVE') {
    return { valid: false, reason: 'MEMBERSHIP_NOT_FOUND', decoded };
  }

  if (membership.tokenVersion !== decoded.ver) {
    return { valid: false, reason: 'STALE_VERSION', decoded, membership };
  }

  return { valid: true, decoded, membership };
}

module.exports = { signQr, verifyQr, QR_TOKEN_TTL };
