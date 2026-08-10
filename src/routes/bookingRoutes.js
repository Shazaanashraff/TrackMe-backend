const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { protect } = require('../middleware/auth');
const { body, query } = require('express-validator');

// Create new booking
router.post(
  '/',
  protect,
  [
    body('vehicleId').isMongoId().withMessage('Valid vehicleId required'),
    body('routeId').isMongoId().withMessage('Valid routeId required'),
    body('seatNumbers').isArray({ min: 1 }).withMessage('At least one seat required'),
    body('journeyDate').isISO8601().withMessage('Valid journeyDate required'),
    body('pricePerSeat').isFloat({ min: 0 }).withMessage('Valid pricePerSeat required'),
    body('totalPrice').isFloat({ min: 0 }).withMessage('Valid totalPrice required')
  ],
  bookingController.createBooking
);

// Get available seats for a vehicle
router.get('/vehicle/:vehicleId/available-seats', protect, bookingController.getAvailableSeats);

// Get bookings for a specific vehicle (driver view)
router.get('/vehicle/:vehicleId/bookings', protect, bookingController.getVehicleBookings);

// Get user's bookings
router.get('/user/my-bookings', protect, bookingController.getUserBookings);

// Get admin booking overview
router.get('/admin/overview', protect, bookingController.getAdminBookingOverview);

// Get single booking
router.get('/:bookingId', protect, bookingController.getBooking);

// Confirm payment
router.patch(
  '/:bookingId/confirm-payment',
  protect,
  [
    body('paymentId').notEmpty().withMessage('paymentId required'),
    body('paymentMethod').isIn(['CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'UPI', 'WALLET']).withMessage('Invalid payment method')
  ],
  bookingController.confirmPayment
);

// Cancel booking
router.patch(
  '/:bookingId/cancel',
  protect,
  bookingController.cancelBooking
);

module.exports = router;
