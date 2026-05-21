const BusReview = require('../models/BusReview');
const Bus = require('../models/Bus');
const mongoose = require('mongoose');

exports.createReview = async (req, res, next) => {
  try {
    const { busId, rating, title, comment } = req.body;

    const bus = await Bus.findById(busId);
    if (!bus || bus.isDeleted) {
      return res.status(404).json({ success: false, message: 'Bus not found' });
    }

    const review = await BusReview.create({
      busId,
      userId: req.user._id,
      rating,
      title,
      comment
    });

    return res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: review
    });
  } catch (error) {
    next(error);
  }
};

exports.getReviewsByBus = async (req, res, next) => {
  try {
    const { busId } = req.params;
    const busObjectId = new mongoose.Types.ObjectId(busId);

    const reviews = await BusReview.find({ busId, isDeleted: false })
      .populate('userId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    const summary = await BusReview.aggregate([
      {
        $match: {
          busId: busObjectId,
          isDeleted: false
        }
      },
      {
        $group: {
          _id: null,
          averageRating: { $avg: '$rating' },
          reviewCount: { $sum: 1 }
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      data: reviews,
      summary: {
        averageRating: Number((summary[0]?.averageRating || 0).toFixed(2)),
        reviewCount: summary[0]?.reviewCount || 0
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.updateReview = async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { rating, title, comment } = req.body;

    const review = await BusReview.findOne({ _id: reviewId, isDeleted: false });
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    const isOwner = String(review.userId) === String(req.user._id);
    const isPrivileged = ['admin', 'super-admin'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this review' });
    }

    if (rating !== undefined) review.rating = rating;
    if (title !== undefined) review.title = title;
    if (comment !== undefined) review.comment = comment;

    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Review updated successfully',
      data: review
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteReview = async (req, res, next) => {
  try {
    const { reviewId } = req.params;

    const review = await BusReview.findOne({ _id: reviewId, isDeleted: false });
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    const isOwner = String(review.userId) === String(req.user._id);
    const isPrivileged = ['admin', 'super-admin'].includes(req.user.role);
    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this review' });
    }

    review.isDeleted = true;
    await review.save();

    return res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
