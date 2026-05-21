const express = require('express');
const router = express.Router();
const {
  createReview,
  getReviewsByBus,
  updateReview,
  deleteReview
} = require('../controllers/busReviewController');
const {
  validateCreateBusReview,
  validateUpdateBusReview,
  validateReviewId,
  validateBusObjectId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect } = require('../middleware/auth');

router.post('/', protect, validateCreateBusReview, handleValidationErrors, createReview);
router.get('/bus/:busId', protect, validateBusObjectId, handleValidationErrors, getReviewsByBus);
router.put('/:reviewId', protect, validateReviewId, validateUpdateBusReview, handleValidationErrors, updateReview);
router.delete('/:reviewId', protect, validateReviewId, handleValidationErrors, deleteReview);

module.exports = router;
