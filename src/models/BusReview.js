const mongoose = require('mongoose');

const busReviewSchema = new mongoose.Schema({
  busId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
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

busReviewSchema.index({ busId: 1, createdAt: -1 });
busReviewSchema.index({ userId: 1, busId: 1 });

module.exports = mongoose.model('BusReview', busReviewSchema);
