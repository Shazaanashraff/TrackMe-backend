const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const userSchema = applyAccountFields(new mongoose.Schema({
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Expo push tokens for this account's device(s). Used to deliver QR boarding/
  // alighting notifications (see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md).
  // This system has no separate parent/child model — the rider's own account is the
  // notification target.
  pushTokens: {
    type: [String],
    default: []
  },
  // Account-scoped QR attendance pass (see docs/features/qr-attendance/QR_SYSTEM.md).
  // One QR per user, valid across every route — bumping qrTokenVersion instantly
  // revokes every previously-issued pass (used by the rotate/regenerate endpoint).
  qrTokenVersion: {
    type: Number,
    default: 1
  },
  qrIssuedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true }));

module.exports = mongoose.model('User', userSchema);
