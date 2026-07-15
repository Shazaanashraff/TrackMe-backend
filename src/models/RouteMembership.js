const mongoose = require('mongoose');

// Persistent per-user access grant to a PRIVATE route (Private Routes feature).
// See PRIVATE_ROUTES_PLAN.md §3.2.
const routeMembershipSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  routeId: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    index: true
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'REVOKED'],
    default: 'ACTIVE',
    index: true
  },
  grantedVia: {
    type: String,
    enum: ['PIN', 'APPROVAL'],
    required: true
  },
  grantedAt: {
    type: Date,
    default: Date.now
  },
  revokedAt: {
    type: Date,
    default: null
  },
  // QR Attendance (see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md). Bumping
  // tokenVersion instantly revokes every previously-issued QR for this membership;
  // a verified token must carry a matching `ver` claim.
  tokenVersion: {
    type: Number,
    default: 1
  },
  qrIssuedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

routeMembershipSchema.index({ userId: 1, routeId: 1 }, { unique: true });
routeMembershipSchema.index({ routeId: 1, status: 1 });

module.exports = mongoose.model('RouteMembership', routeMembershipSchema);
