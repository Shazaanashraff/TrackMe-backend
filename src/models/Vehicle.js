const mongoose = require('mongoose');
const { plateKey } = require('../utils/numberPlate');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

const vehicleSchema = new mongoose.Schema({
  vehicleId: {
    type: String,
    required: [true, 'Vehicle ID is required'],
    unique: true,
    trim: true
  },
  vehicleName: {
    type: String,
    required: [true, 'Vehicle name is required'],
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
  // The registration behind the plate, province prefix dropped, kept unique so
  // no two vehicles can claim the same bus however their plates were written.
  // Maintained by the hook below rather than by callers; a soft-deleted vehicle
  // keeps its key, because the registration is still spoken for.
  plateKey: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true
  },
  // A vehicle can sit in the fleet before it has been put on a route, so this
  // is filled in on the Vehicles page rather than demanded at creation.
  routeId: {
    type: String,
    default: '',
    trim: true
  },
  // Null while the vehicle is unassigned. A vehicle added from the Vehicles
  // page starts that way; one created alongside a driver does not.
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    default: null
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    default: null
  },
  // The school / university / office this vehicle runs for, matching the
  // organization on its driver. Null for public service.
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    index: true
  },
  // Unknown until someone fills it in; the bounds still apply once it is set.
  seatCapacity: {
    type: Number,
    default: null,
    min: [1, 'Seat capacity must be at least 1'],
    max: [100, 'Seat capacity cannot exceed 100']
  },
  vehicleType: {
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

// The plate is the vehicle's identity, so its key is derived here rather than
// trusted from whoever is saving. Every write path in the app goes through
// save(), so this runs on creation and on a plate change alike.
vehicleSchema.pre('save', function derivePlateKey(next) {
  if (this.isModified('numberPlate') || !this.plateKey) {
    const key = plateKey(this.numberPlate);
    this.plateKey = key || undefined;
  }
  next();
});

// Index for faster queries
// Note: numberPlate already has a unique index from `unique: true` on the field.
vehicleSchema.index({ routeId: 1, isDeleted: 1 });
vehicleSchema.index({ driverId: 1 });
vehicleSchema.index({ managerId: 1 });
vehicleSchema.index({ isActive: 1, maintenanceStatus: 1 });
vehicleSchema.index({ serviceType: 1, bookingEnabled: 1, isDeleted: 1 });

module.exports = mongoose.model('Vehicle', vehicleSchema);
