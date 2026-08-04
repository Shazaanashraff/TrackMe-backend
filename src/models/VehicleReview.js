const mongoose = require('mongoose');

const vehicleReviewSchema = new mongoose.Schema({
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  rating: {
    type: Number,
    required: [true, 'Rating is required'],
    min: [1, 'Rating should be at least 1'],
    max: [5, 'Rating cannot exceed 5']
  },
  title: {
    type: String,
    trim: true,
    maxlength: 120
  },
  comment: {
    type: String,
    trim: true,
    maxlength: 1200
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

vehicleReviewSchema.index({ vehicleId: 1, createdAt: -1 });
vehicleReviewSchema.index({ userId: 1, vehicleId: 1 });

module.exports = mongoose.model('VehicleReview', vehicleReviewSchema);
