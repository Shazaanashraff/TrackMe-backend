// Rider-facing QR endpoints — see docs/features/qr-attendance/QR_SYSTEM.md.
const jwt = require('jsonwebtoken');
const { signQr } = require('../utils/qrToken');

function toIssuedToken(user) {
  const { token, payload } = signQr(user);
  const decoded = jwt.decode(token);
  return {
    token,
    tokenVersion: payload.ver,
    issuedAt: new Date().toISOString(),
    expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null
  };
}

// @desc    Issue a fresh QR token for the caller's account. Account-scoped — not tied
//          to any route, so one pass is reusable everywhere the rider boards.
// @route   POST /api/qr/issue
exports.issueQr = async (req, res, next) => {
  try {
    const entry = toIssuedToken(req.user);
    req.user.qrIssuedAt = new Date();
    await req.user.save();

    return res.status(200).json({ success: true, data: entry });
  } catch (error) {
    next(error);
  }
};

// @desc    Bump the caller's qrTokenVersion, revoking every previously-issued QR pass.
// @route   POST /api/qr/rotate
exports.rotateQr = async (req, res, next) => {
  try {
    req.user.qrTokenVersion += 1;
    await req.user.save();

    return res.status(200).json({ success: true, data: { tokenVersion: req.user.qrTokenVersion } });
  } catch (error) {
    next(error);
  }
};
