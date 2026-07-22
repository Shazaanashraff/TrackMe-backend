const mongoose = require('mongoose');

const ACTOR_MODEL_BY_ROLE = { admin: 'Manager', 'super-admin': 'SuperAdmin' };

const managerAuditLogSchema = new mongoose.Schema({
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    required: true,
    index: true
  },
  action: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  entityType: {
    type: String,
    enum: ['BUS', 'BUS_REQUEST', 'BUS_ACCOUNT', 'ROUTE', 'ROUTE_CHANGE_REQUEST', 'ROUTE_JOIN_REQUEST', 'ROUTE_MEMBERSHIP'],
    required: true
  },
  entityId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  actorRole: {
    type: String,
    enum: ['admin', 'super-admin'],
    required: true
  },
  // Derived from actorRole (see pre-validate hook below) so actorId can be
  // populated correctly even though it points to two different collections
  // depending on whether the actor was a manager or the super-admin.
  actorModel: {
    type: String,
    enum: ['Manager', 'SuperAdmin']
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'actorModel',
    required: true
  }
}, {
  timestamps: true
});

managerAuditLogSchema.pre('validate', function deriveActorModel(next) {
  this.actorModel = ACTOR_MODEL_BY_ROLE[this.actorRole] || this.actorModel;
  next();
});

managerAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ManagerAuditLog', managerAuditLogSchema);
