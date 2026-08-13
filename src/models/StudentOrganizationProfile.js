const mongoose = require('mongoose');

const studentOrganizationProfileSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StudentProfile',
    required: true,
    index: true
  },
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  schemaVersion: {
    type: Number,
    required: true,
    default: 1
  },
  values: {
    type: Map,
    of: String,
    default: {}
  },
  needsUpdate: {
    type: Boolean,
    default: false,
    index: true
  },
  legacyGrandfathered: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

studentOrganizationProfileSchema.index(
  { studentId: 1, organizationId: 1 },
  { unique: true }
);

module.exports = mongoose.model('StudentOrganizationProfile', studentOrganizationProfileSchema);
