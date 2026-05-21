const mongoose = require('mongoose');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

const BookingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  busId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
    required: true,
    index: true
  },
  routeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route',
    required: true,
    index: true
  },
  seatNumbers: {
    type: [Number],
    required: true,
    validate: {
      validator: (v) => v && v.length > 0,
      message: 'At least one seat must be booked'
    }
  },
  totalPassengers: {
    type: Number,
    required: true,
    default: 1
  },
  pricePerSeat: {
    type: Number,
    required: true,
    default: 0
  },
  totalPrice: {
    type: Number,
    required: true,
    default: 0
  },
  serviceType: {
    type: String,
    enum: SERVICE_TYPES,
    default: 'PUBLIC',
    uppercase: true,
    index: true
  },
  status: {
    type: String,
    enum: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED'],
    default: 'PENDING_PAYMENT',
    index: true
  },
  paymentId: {
    type: String,
    default: null
  },
  paymentMethod: {
    type: String,
    enum: ['CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'UPI', 'WALLET'],
    default: null
  },
  paymentStatus: {
    type: String,
    enum: ['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'],
    default: 'PENDING'
  },
  journeyDate: {
    type: Date,
    required: true,
    index: true
  },
  bookingDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  pickupStop: {
    id: mongoose.Schema.Types.ObjectId,
    name: String,
    latitude: Number,
    longitude: Number
  },
  dropoffStop: {
    id: mongoose.Schema.Types.ObjectId,
    name: String,
    latitude: Number,
    longitude: Number
  },
  passengerDetails: [{
    name: {
      type: String,
      required: true
    },
    phone: {
      type: String,
      required: true
    },
    gender: {
      type: String,
      enum: ['M', 'F', 'O'],
      required: true
    },
    age: Number
  }],
  ticketNumbers: [String], // Generated ticket numbers
  notes: String,
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

// Virtual for calculating days until journey
BookingSchema.virtual('daysUntilJourney').get(function() {
  const now = new Date();
  const journey = new Date(this.journeyDate);
  const diff = journey - now;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
});

// Index for finding bookings by user and date range
BookingSchema.index({ userId: 1, journeyDate: 1 });

// Index for finding available seats
BookingSchema.index({ busId: 1, journeyDate: 1, status: 1 });

module.exports = mongoose.model('Booking', BookingSchema);
