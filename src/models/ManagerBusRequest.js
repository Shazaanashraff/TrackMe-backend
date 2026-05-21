const mongoose = require('mongoose');

const managerBusRequestSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['CREATE_BUS_ACCOUNT', 'DELETE_BUS'],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  busId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  reason: {
    type: String,
    trim: true,
    default: ''
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: null
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

managerBusRequestSchema.index({ managerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ManagerBusRequest', managerBusRequestSchema);
