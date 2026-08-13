// Rider-facing QR endpoints — see docs/features/qr-attendance/QR_SYSTEM.md.
const jwt = require('jsonwebtoken');
const { signQr } = require('../utils/qrToken');
const { findOwnedRider } = require('../utils/riders');
const DriverEnrollment = require('../models/DriverEnrollment');

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
    const rider = await findOwnedRider(req.user, req.body?.riderId || req.body?.studentId);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    const hasActiveEnrollment = await DriverEnrollment.exists({ studentId: rider._id, status: 'ACTIVE' });
    if (!hasActiveEnrollment) {
      return res.status(409).json({ success: false, message: 'This rider needs an active shuttle before a vehicle pass can be issued' });
    }
    const entry = toIssuedToken(rider);
    rider.qrIssuedAt = new Date();
    await rider.save();

    return res.status(200).json({ success: true, data: { ...entry, riderId: rider._id, studentId: rider._id, riderCode: rider.riderCode } });
  } catch (error) {
    next(error);
  }
};

// @desc    Bump the caller's qrTokenVersion, revoking every previously-issued QR pass.
// @route   POST /api/qr/rotate
exports.rotateQr = async (req, res, next) => {
  try {
    const rider = await findOwnedRider(req.user, req.body?.riderId || req.body?.studentId);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    rider.qrTokenVersion += 1;
    await rider.save();

    return res.status(200).json({ success: true, data: { riderId: rider._id, studentId: rider._id, tokenVersion: rider.qrTokenVersion } });
  } catch (error) {
    next(error);
  }
};
