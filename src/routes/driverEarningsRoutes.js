const express = require('express');
const router = express.Router();
const driverEarningsController = require('../controllers/driverEarningsController');
const { protect } = require('../middleware/auth');
const { body } = require('express-validator');

// Get earnings statistics
router.get('/stats', protect, driverEarningsController.getEarningsStats);

// Get daily breakdown for current month
router.get('/daily-breakdown', protect, driverEarningsController.getDailyBreakdown);

// Get earnings history with pagination
router.get('/history', protect, driverEarningsController.getEarningsHistory);

// Get specific earning details
router.get('/:earningId', protect, driverEarningsController.getEarningDetails);

// Log a new trip (admin/system use)
router.post(
  '/log-trip',
  protect,
  [
    body('driverId').isMongoId().withMessage('Valid driverId required'),
    body('busId').isMongoId().withMessage('Valid busId required'),
    body('routeId').isMongoId().withMessage('Valid routeId required'),
    body('journeyDate').isISO8601().withMessage('Valid journeyDate required'),
    body('startTime').isISO8601().withMessage('Valid startTime required'),
    body('endTime').isISO8601().withMessage('Valid endTime required'),
    body('grossEarnings').isFloat({ min: 0 }).withMessage('Valid grossEarnings required')
  ],
  driverEarningsController.logTrip
);

// Request payout
router.patch(
  '/:earningId/request-payout',
  protect,
  [
    body('bankAccount.accountNumber').notEmpty().withMessage('Account number required'),
    body('bankAccount.bankName').notEmpty().withMessage('Bank name required'),
    body('bankAccount.ifscCode').notEmpty().withMessage('IFSC code required')
  ],
  driverEarningsController.requestPayout
);

module.exports = router;
