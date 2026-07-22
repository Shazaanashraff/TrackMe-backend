const mongoose = require('mongoose');

const DriverEarningsSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true,
    index: true
  },
  busId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
    required: true,
    index: true
  },
  tripId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  routeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route',
    required: true
  },
  journeyDate: {
    type: Date,
    required: true,
    index: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    default: null
  },
  totalDistance: {
    type: Number,
    default: 0
  },
  totalPassengers: {
    type: Number,
    default: 0,
    index: true
  },
  grossEarnings: {
    type: Number,
    required: true,
    default: 0
  },
  commission: {
    type: Number,
    default: 0
  },
  netEarnings: {
    type: Number,
    required: true,
    default: 0
  },
  deductions: [{
    description: String,
    amount: Number,
    type: String // FUEL, MAINTENANCE, PENALTY, OTHER
  }],
  bonusEarnings: {
    type: Number,
    default: 0
  },
  paymentStatus: {
    type: String,
    enum: ['PENDING', 'PROCESSED', 'PAID', 'FAILED'],
    default: 'PENDING',
    index: true
  },
  paymentDate: {
    type: Date,
    default: null
  },
  paymentMethod: {
    type: String,
    enum: ['BANK_TRANSFER', 'CASH', 'WALLET'],
    default: 'BANK_TRANSFER'
  },
  bankAccount: {
    accountNumber: String,
    bankName: String,
    ifscCode: String
  },
  notes: String,
  status: {
    type: String,
    enum: ['ACTIVE', 'CANCELLED', 'DISPUTED'],
    default: 'ACTIVE'
  }
}, { timestamps: true });

// Indexes for performance
DriverEarningsSchema.index({ driverId: 1, journeyDate: -1 });
DriverEarningsSchema.index({ driverId: 1, paymentStatus: 1 });
DriverEarningsSchema.index({ journeyDate: 1, paymentStatus: 1 });

// Virtual for formatted net earnings
DriverEarningsSchema.virtual('formattedEarnings').get(function() {
  return {
    gross: this.grossEarnings,
    commission: this.commission,
    deductions: this.deductions.reduce((sum, d) => sum + d.amount, 0),
    bonus: this.bonusEarnings,
    net: this.netEarnings
  };
});

module.exports = mongoose.model('DriverEarnings', DriverEarningsSchema);
