const mongoose = require('mongoose');

// Approval flow for PRIVATE routes with joinApprovalRequired:true. Mirrors
// ManagerBusRequest. See PRIVATE_ROUTES_PLAN.md §3.3.
const routeJoinRequestSchema = new mongoose.Schema({
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
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  pinVerified: {
    type: Boolean,
    default: true
  },
  decisionBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  decisionNote: {
    type: String,
    trim: true,
    default: ''
  },
  decidedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Block duplicate open requests for the same user/route.
routeJoinRequestSchema.index(
  { userId: 1, routeId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } }
);
routeJoinRequestSchema.index({ managerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('RouteJoinRequest', routeJoinRequestSchema);
