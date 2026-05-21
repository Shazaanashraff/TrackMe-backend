const mongoose = require('mongoose');

const managerAuditLogSchema = new mongoose.Schema({
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    enum: ['BUS', 'BUS_REQUEST', 'BUS_ACCOUNT'],
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
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

managerAuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ManagerAuditLog', managerAuditLogSchema);
