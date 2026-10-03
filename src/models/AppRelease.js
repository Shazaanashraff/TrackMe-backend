const mongoose = require('mongoose');

const APPS = ['driver', 'rider'];
const PLATFORMS = ['android', 'ios'];

const appReleaseSchema = new mongoose.Schema({
  // 'rider' maps to the user-app/passenger app — matches the domain's existing
  // "rider" naming (see RiderProfile) rather than "user".
  app: {
    type: String,
    enum: APPS,
    required: [true, 'App is required']
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    required: [true, 'Platform is required']
  },
  version: {
    type: String,
    required: [true, 'Version is required'],
    trim: true
  },
  // Android versionCode / iOS build number. iOS gets no in-app update check
  // (only a notification), so this is a placeholder for iOS rows.
  versionCode: {
    type: Number,
    required: [true, 'Version code is required']
  },
  downloadUrl: {
    type: String,
    required: [true, 'Download URL is required'],
    trim: true
  },
  releaseNotes: {
    type: String,
    default: ''
  },
  mandatory: {
    type: Boolean,
    default: false
  },
  fileSizeBytes: {
    type: Number
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

appReleaseSchema.index({ app: 1, platform: 1, isActive: 1 });

module.exports = mongoose.model('AppRelease', appReleaseSchema);
module.exports.APPS = APPS;
module.exports.PLATFORMS = PLATFORMS;
