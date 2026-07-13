const mongoose = require('mongoose');

// Brute-force throttle for room-key verification attempts, per (userId, routeId).
// See PRIVATE_ROUTES_PLAN.md §4.
const routeKeyAttemptSchema = new mongoose.Schema({
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
  count: {
    type: Number,
    default: 0
  },
  lockedUntil: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

routeKeyAttemptSchema.index({ userId: 1, routeId: 1 }, { unique: true });

module.exports = mongoose.model('RouteKeyAttempt', routeKeyAttemptSchema);
