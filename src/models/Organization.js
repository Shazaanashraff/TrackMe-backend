const mongoose = require('mongoose');

// An Organization is the specific school / university / office a private-service
// manager belongs to (e.g. "Royal College", "University of Colombo"). PUBLIC
// managers have no organization — only the private service types use these.
const ORG_SERVICE_TYPES = ['SCHOOL', 'UNIVERSITY', 'OFFICE'];

const organizationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Organization name is required'],
    trim: true
  },
  serviceType: {
    type: String,
    enum: ORG_SERVICE_TYPES,
    required: [true, 'Service type is required'],
    uppercase: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// A name is unique within its service type (a school and an office may share a name,
// but two schools may not). Case-insensitive so "Royal College" == "royal college".
organizationSchema.index(
  { serviceType: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

const Organization = mongoose.model('Organization', organizationSchema);

module.exports = Organization;
module.exports.ORG_SERVICE_TYPES = ORG_SERVICE_TYPES;
