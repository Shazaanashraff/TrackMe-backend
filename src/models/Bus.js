const mongoose = require('mongoose');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

const busSchema = new mongoose.Schema({
  busId: {
    type: String,
    required: [true, 'Bus ID is required'],
    unique: true,
    trim: true
  },
  busName: {
    type: String,
    required: [true, 'Bus name is required'],
    trim: true
  },
  registrationNumber: {
    type: String,
    required: [true, 'Registration number is required'],
    unique: true,
    trim: true
  },
  numberPlate: {
    type: String,
    required: [true, 'Number plate is required'],
    unique: true,
    trim: true,
    uppercase: true
  },
  routeId: {
    type: String,
    required: [true, 'Route ID is required'],
    trim: true
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: [true, 'Driver ID is required']
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    default: null
  },
  seatCapacity: {
    type: Number,
    required: [true, 'Seat capacity is required'],
    min: [1, 'Seat capacity must be at least 1'],
    max: [100, 'Seat capacity cannot exceed 100']
  },
  busType: {
    type: String,
    enum: ['AC', 'NON-AC', 'DELUXE', 'SLEEPER'],
    default: 'AC'
  },
  serviceType: {
    type: String,
    enum: SERVICE_TYPES,
    default: 'PUBLIC',
    uppercase: true
  },
  bookingEnabled: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  maintenanceStatus: {
    type: String,
    enum: ['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE'],
    default: 'ACTIVE'
  },
  lastServiceDate: Date,
  nextServiceDate: Date,
  registrationExpiry: Date,
  insuranceExpiry: Date
}, {
  timestamps: true
});

// Index for faster queries
// Note: numberPlate already has a unique index from `unique: true` on the field.
busSchema.index({ routeId: 1, isDeleted: 1 });
busSchema.index({ driverId: 1 });
busSchema.index({ managerId: 1 });
busSchema.index({ isActive: 1, maintenanceStatus: 1 });
busSchema.index({ serviceType: 1, bookingEnabled: 1, isDeleted: 1 });

module.exports = mongoose.model('Bus', busSchema);
