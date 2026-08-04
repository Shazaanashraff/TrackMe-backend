const mongoose = require('mongoose');

const liveLocationSchema = new mongoose.Schema({
  vehicleId: {
    type: String,
    required: [true, 'Vehicle ID is required'],
    index: true
  },
  routeId: {
    type: String,
    required: [true, 'Route ID is required'],
    index: true
  },
  lat: {
    type: Number,
    required: [true, 'Latitude is required']
  },
  lng: {
    type: Number,
    required: [true, 'Longitude is required']
  },
  accuracy: {
    type: Number,
    default: null
  },
  speed: {
    type: Number,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
liveLocationSchema.index({ vehicleId: 1, timestamp: -1 });

module.exports = mongoose.model('LiveLocation', liveLocationSchema);
