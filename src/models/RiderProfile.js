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
  // What this rider says they are, answered when the account is created. It seeds
  // the enrolment form and the profile copy; it is never the authority on what a
  // rider *is* to an organization — that stays derived from the enrolled driver's
  // Organization.serviceType (utils/riderTag.js), and the two may legitimately
  // disagree when someone rides an office shuttle to their university.
  category: {
    type: String,
    enum: ['SCHOOL', 'UNIVERSITY', 'OFFICE', null],
    default: null
  },
  // Keyed by the enrolment field catalog (utils/enrollmentSchema.js), so a grade
  // given at signup is the same `grade` the school's enrolment form asks for and
  // can prefill it.
  details: {
    type: Map,
    of: String,
    default: undefined
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
