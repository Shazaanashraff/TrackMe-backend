const mongoose = require('mongoose');

const householdPlaceSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  label: {
    type: String,
    required: [true, 'Location label is required'],
    trim: true
  },
  address: {
    type: String,
    required: [true, 'Address is required'],
    trim: true
  },
  placeId: {
    type: String,
    trim: true,
    default: ''
  },
  coordinates: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

householdPlaceSchema.index({ accountId: 1, isActive: 1, label: 1 });

module.exports = mongoose.model('HouseholdPlace', householdPlaceSchema);
