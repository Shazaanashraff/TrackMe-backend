const express = require('express');
const router = express.Router();
const driverTripController = require('../controllers/driverTripController');
const { protect } = require('../middleware/auth');
const { body } = require('express-validator');

// Log a completed trip (admin/system use). Declared before '/:tripId' so the literal
// path is not swallowed by the id param.
router.post(
  '/log',
  protect,
  [
    body('driverId').isMongoId().withMessage('Valid driverId required'),
    body('vehicleId').isMongoId().withMessage('Valid vehicleId required'),
    body('routeId').isMongoId().withMessage('Valid routeId required'),
    body('journeyDate').isISO8601().withMessage('Valid journeyDate required'),
    body('startTime').isISO8601().withMessage('Valid startTime required'),
    body('endTime').isISO8601().withMessage('Valid endTime required')
  ],
  driverTripController.logTrip
);

// Trip history with pagination
router.get('/', protect, driverTripController.getTripHistory);

// Specific trip details
router.get('/:tripId', protect, driverTripController.getTripDetails);

module.exports = router;
