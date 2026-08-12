const mongoose = require('mongoose');

const managerVehicleRequestSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['CREATE_VEHICLE_ACCOUNT', 'DELETE_VEHICLE'],
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
    ref: 'Manager',
    required: true,
    index: true
  },
  vehicleId: {
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
    ref: 'SuperAdmin',
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

managerVehicleRequestSchema.index({ managerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ManagerVehicleRequest', managerVehicleRequestSchema);
