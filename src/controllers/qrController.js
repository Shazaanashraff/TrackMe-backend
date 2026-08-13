// Rider-facing QR endpoints — see docs/features/qr-attendance/QR_SYSTEM.md.
const jwt = require('jsonwebtoken');
const { signQr } = require('../utils/qrToken');
const { findOwnedStudent } = require('../utils/students');
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
    const student = await findOwnedStudent(req.user, req.body?.studentId);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    const hasActiveEnrollment = await DriverEnrollment.exists({ studentId: student._id, status: 'ACTIVE' });
    if (!hasActiveEnrollment) {
      return res.status(409).json({ success: false, message: 'This student needs an active shuttle before a vehicle pass can be issued' });
    }
    const entry = toIssuedToken(student);
    student.qrIssuedAt = new Date();
    await student.save();

    return res.status(200).json({ success: true, data: { ...entry, studentId: student._id, riderCode: student.riderCode } });
  } catch (error) {
    next(error);
  }
};

// @desc    Bump the caller's qrTokenVersion, revoking every previously-issued QR pass.
// @route   POST /api/qr/rotate
exports.rotateQr = async (req, res, next) => {
  try {
    const student = await findOwnedStudent(req.user, req.body?.studentId);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    student.qrTokenVersion += 1;
    await student.save();

    return res.status(200).json({ success: true, data: { studentId: student._id, tokenVersion: student.qrTokenVersion } });
  } catch (error) {
    next(error);
  }
};
