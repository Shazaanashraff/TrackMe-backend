const mongoose = require('mongoose');

const riderProfileSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  riderCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  fullName: {
    type: String,
    required: [true, 'Rider full name is required'],
    trim: true
  },
  guardianPhoneOverride: {
    type: String,
    trim: true,
    default: ''
  },
  avatarUrl: { type: String, default: '' },
  defaultPickupPlaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HouseholdPlace',
    default: null
  },
  defaultDropoffPlaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HouseholdPlace',
    default: null
  },
  qrTokenVersion: { type: Number, default: 1 },
  qrIssuedAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true, index: true },
  migratedFromLegacyUser: { type: Boolean, default: false }
}, {
  timestamps: true,
  // Preserve deployed data while the application domain moves to rider terms.
  collection: 'studentprofiles'
});

riderProfileSchema.index({ accountId: 1, isActive: 1, createdAt: 1 });

module.exports = mongoose.models.RiderProfile
  || mongoose.model('RiderProfile', riderProfileSchema, 'studentprofiles');
