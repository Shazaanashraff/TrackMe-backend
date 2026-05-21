const Booking = require('../models/Booking');
const Bus = require('../models/Bus');
const User = require('../models/User');
const Route = require('../models/Route');
const { validationResult } = require('express-validator');

const getStartAndEndOfDay = (dateInput) => {
  const start = new Date(dateInput);
  start.setHours(0, 0, 0, 0);

  const end = new Date(dateInput);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const normalizeStop = (stop) => ({
  id: stop?._id,
  name: stop?.name ?? stop?.stopName ?? 'Unknown Stop',
  latitude: stop?.latitude ?? stop?.lat ?? null,
  longitude: stop?.longitude ?? stop?.lng ?? null
});

/**
 * POST /api/bookings
 * Create a new booking (reserve seats)
 */
const createBooking = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const {
      busId,
      routeId,
      seatNumbers,
      journeyDate,
      pickupStopIndex,
      dropoffStopIndex,
      passengerDetails,
      pricePerSeat,
      totalPrice
    } = req.body;

    // Verify bus exists
    const bus = await Bus.findById(busId);
    if (!bus) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    if (!bus.bookingEnabled) {
      return res.status(403).json({
        message: 'Booking is currently disabled for this bus'
      });
    }

    // Verify route exists
    const route = await Route.findById(routeId);
    if (!route) {
      return res.status(404).json({ message: 'Route not found' });
    }

    if (!Array.isArray(route.stops) || route.stops.length === 0) {
      return res.status(400).json({ message: 'Route has no configured stops' });
    }

    let effectivePickupStopIndex = Number.isInteger(pickupStopIndex) ? pickupStopIndex : 0;
    let effectiveDropoffStopIndex = Number.isInteger(dropoffStopIndex)
      ? dropoffStopIndex
      : route.stops.length - 1;

    if (
      effectiveDropoffStopIndex <= effectivePickupStopIndex &&
      route.stops.length > 1
    ) {
      effectiveDropoffStopIndex = route.stops.length - 1;
    }

    // Get pickup and dropoff stops
    const pickupStop = route.stops[effectivePickupStopIndex];
    const dropoffStop = route.stops[effectiveDropoffStopIndex];

    if (!pickupStop || !dropoffStop) {
      return res.status(400).json({ message: 'Invalid pickup or dropoff stop' });
    }

    // Check if seats are already booked for this bus on this date
    const { start, end } = getStartAndEndOfDay(journeyDate);

    const existingBookings = await Booking.find({
      busId,
      journeyDate: {
        $gte: start,
        $lte: end
      },
      status: { $in: ['CONFIRMED', 'PENDING_PAYMENT'] },
      isDeleted: false
    });

    const bookedSeats = existingBookings.reduce((acc, booking) => {
      return [...acc, ...booking.seatNumbers];
    }, []);

    const requestedSeats = seatNumbers || [];
    const conflictingSeats = requestedSeats.filter(seat => bookedSeats.includes(seat));

    if (conflictingSeats.length > 0) {
      return res.status(409).json({
        message: `Seats ${conflictingSeats.join(', ')} are already booked`,
        conflictingSeats
      });
    }

    // Create booking
    const booking = new Booking({
      userId,
      busId,
      routeId,
      seatNumbers: requestedSeats,
      totalPassengers: passengerDetails?.length || 1,
      pricePerSeat,
      totalPrice,
      serviceType: bus.serviceType || 'PUBLIC',
      journeyDate: new Date(journeyDate),
      pickupStop: normalizeStop(pickupStop),
      dropoffStop: normalizeStop(dropoffStop),
      passengerDetails: passengerDetails || [],
      status: 'PENDING_PAYMENT'
    });

    await booking.save();

    // Populate references for response
    await booking.populate(['userId', 'busId', 'routeId']);

    return res.status(201).json({
      message: 'Booking created successfully',
      booking,
      paymentRequired: true,
      amount: totalPrice
    });
  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ message: 'Failed to create booking', error: error.message });
  }
};

/**
 * GET /api/bookings/:bookingId
 * Get booking details
 */
const getBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;

    const booking = await Booking.findById(bookingId)
      .populate('userId', 'name email phone')
      .populate('busId', 'busName registrationNumber busType')
      .populate('routeId', 'source destination fare');

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Check authorization
    if (booking.userId._id.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    return res.json(booking);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ message: 'Failed to fetch booking', error: error.message });
  }
};

/**
 * GET /api/bookings/user/my-bookings
 * Get all bookings for current user
 */
const getUserBookings = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10, status = null } = req.query;

    const query = { userId, isDeleted: false };
    if (status) query.status = status;

    const bookings = await Booking.find(query)
      .populate('busId', 'busName registrationNumber busType')
      .populate('routeId', 'source destination')
      .sort({ journeyDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Booking.countDocuments(query);

    return res.json({
      bookings,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalBookings: total
      }
    });
  } catch (error) {
    console.error('Get user bookings error:', error);
    res.status(500).json({ message: 'Failed to fetch bookings', error: error.message });
  }
};

/**
 * GET /api/bookings/bus/:busId/available-seats
 * Get available seats for a bus on a specific date
 */
const getAvailableSeats = async (req, res) => {
  try {
    const { busId } = req.params;
    const { journeyDate } = req.query;

    if (!journeyDate) {
      return res.status(400).json({ message: 'journeyDate required' });
    }

    // Get bus details
    const bus = await Bus.findById(busId);
    if (!bus) {
      return res.status(404).json({ message: 'Bus not found' });
    }

    // Get all booked seats for this date
    const { start, end } = getStartAndEndOfDay(journeyDate);

    const bookings = await Booking.find({
      busId,
      journeyDate: {
        $gte: start,
        $lte: end
      },
      status: { $in: ['CONFIRMED', 'PENDING_PAYMENT'] },
      isDeleted: false
    }).select('seatNumbers');

    const bookedSeats = bookings.reduce((acc, booking) => {
      return [...acc, ...booking.seatNumbers];
    }, []);

    // Generate all seat numbers based on bus capacity
    const totalSeats = bus.seatCapacity || 45;
    const allSeats = Array.from({ length: totalSeats }, (_, i) => i + 1);
    const availableSeats = allSeats.filter(seat => !bookedSeats.includes(seat));

    return res.json({
      busId,
      journeyDate,
      totalSeats,
      bookedSeats: bookedSeats.length,
      availableCount: availableSeats.length,
      availableSeats
    });
  } catch (error) {
    console.error('Get available seats error:', error);
    res.status(500).json({ message: 'Failed to fetch available seats', error: error.message });
  }
};

/**
 * PATCH /api/bookings/:bookingId/confirm-payment
 * Confirm payment and update booking status
 */
const confirmPayment = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;
    const { paymentId, paymentMethod, transactionId } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Verify ownership
    if (booking.userId.toString() !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update booking
    booking.paymentId = paymentId;
    booking.paymentMethod = paymentMethod;
    booking.paymentStatus = 'SUCCESS';
    booking.status = 'CONFIRMED';

    // Generate ticket numbers
    booking.ticketNumbers = booking.seatNumbers.map(
      seat => `TKT-${bookingId.slice(-8).toUpperCase()}-${seat}`
    );

    await booking.save();

    await booking.populate(['busId', 'routeId']);

    return res.json({
      message: 'Payment confirmed and booking confirmed',
      booking,
      ticketNumbers: booking.ticketNumbers
    });
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ message: 'Failed to confirm payment', error: error.message });
  }
};

/**
 * PATCH /api/bookings/:bookingId/cancel
 * Cancel a booking
 */
const cancelBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;
    const { reason } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Verify ownership
    if (booking.userId.toString() !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Only cancel if not already completed
    if (booking.status === 'COMPLETED') {
      return res.status(400).json({ message: 'Cannot cancel completed booking' });
    }

    // Calculate refund
    let refundAmount = 0;
    if (booking.status === 'CONFIRMED' && booking.paymentStatus === 'SUCCESS') {
      // 75% refund if cancelled more than 24 hours before journey
      const hoursUntilJourney = (booking.journeyDate - new Date()) / (1000 * 60 * 60);
      refundAmount = hoursUntilJourney > 24 ? booking.totalPrice * 0.75 : booking.totalPrice * 0.25;
    }

    booking.status = 'CANCELLED';
    booking.paymentStatus = 'REFUNDED';
    booking.notes = reason || 'Cancelled by user';
    booking.isDeleted = true;

    await booking.save();

    return res.json({
      message: 'Booking cancelled successfully',
      booking,
      refundAmount,
      refundPolicy: 'Refund will be processed within 5-7 business days'
    });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ message: 'Failed to cancel booking', error: error.message });
  }
};

/**
 * GET /api/bookings/bus/:busId/bookings
 * Get bookings for a specific bus (for driver)
 */
const getBusBookings = async (req, res) => {
  try {
    const { busId } = req.params;
    const { journeyDate } = req.query;

    const query = {
      busId,
      status: 'CONFIRMED',
      isDeleted: false
    };

    if (journeyDate) {
      const { start, end } = getStartAndEndOfDay(journeyDate);
      query.journeyDate = {
        $gte: start,
        $lte: end
      };
    }

    const bookings = await Booking.find(query)
      .populate('userId', 'name phone email')
      .select('seatNumbers passengerDetails pickupStop dropoffStop userId totalPassengers')
      .sort({ journeyDate: 1 })
      .lean();

    return res.json({
      busId,
      journeyDate: journeyDate || 'all',
      totalBookings: bookings.length,
      bookings
    });
  } catch (error) {
    console.error('Get bus bookings error:', error);
    res.status(500).json({ message: 'Failed to fetch bus bookings', error: error.message });
  }
};

/**
 * GET /api/bookings/admin/overview
 * Get booking and revenue overview (admin)
 */
const getAdminBookingOverview = async (req, res) => {
  try {
    if (!['admin', 'super-admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Admin or super-admin access required' });
    }

    const { days = 30, limit = 8 } = req.query;
    const daysNumber = Math.max(1, Number(days) || 30);
    const limitNumber = Math.max(1, Number(limit) || 8);
    const fromDate = new Date(Date.now() - daysNumber * 24 * 60 * 60 * 1000);

    const [summary, recentBookings] = await Promise.all([
      Booking.aggregate([
        {
          $match: {
            isDeleted: false,
            createdAt: { $gte: fromDate }
          }
        },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            confirmedBookings: {
              $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] }
            },
            pendingBookings: {
              $sum: { $cond: [{ $eq: ['$status', 'PENDING_PAYMENT'] }, 1, 0] }
            },
            cancelledBookings: {
              $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] }
            },
            totalRevenue: {
              $sum: {
                $cond: [{ $eq: ['$status', 'CONFIRMED'] }, '$totalPrice', 0]
              }
            }
          }
        }
      ]),
      Booking.find({ isDeleted: false })
        .populate('userId', 'name email')
        .populate('busId', 'busName busId')
        .populate('routeId', 'routeId source destination')
        .sort({ createdAt: -1 })
        .limit(limitNumber)
        .lean()
    ]);

    return res.json({
      days: daysNumber,
      fromDate,
      summary: summary[0] || {
        totalBookings: 0,
        confirmedBookings: 0,
        pendingBookings: 0,
        cancelledBookings: 0,
        totalRevenue: 0
      },
      recentBookings
    });
  } catch (error) {
    console.error('Get admin booking overview error:', error);
    return res.status(500).json({ message: 'Failed to fetch booking overview', error: error.message });
  }
};

module.exports = {
  createBooking,
  getBooking,
  getUserBookings,
  getAvailableSeats,
  confirmPayment,
  cancelBooking,
  getBusBookings,
  getAdminBookingOverview
};
