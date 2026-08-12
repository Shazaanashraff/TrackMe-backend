const express = require('express');
const router = express.Router();
const {
  createReview,
  getReviewsByVehicle,
  updateReview,
  deleteReview
} = require('../controllers/vehicleReviewController');
const {
  validateCreateVehicleReview,
  validateUpdateVehicleReview,
  validateReviewId,
  validateVehicleObjectId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect } = require('../middleware/auth');

router.post('/', protect, validateCreateVehicleReview, handleValidationErrors, createReview);
router.get('/vehicle/:vehicleId', protect, validateVehicleObjectId, handleValidationErrors, getReviewsByVehicle);
router.put('/:reviewId', protect, validateReviewId, validateUpdateVehicleReview, handleValidationErrors, updateReview);
router.delete('/:reviewId', protect, validateReviewId, handleValidationErrors, deleteReview);

module.exports = router;
