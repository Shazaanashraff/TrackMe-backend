const DriverTrip = require('../models/DriverTrip');
const Vehicle = require('../models/Vehicle');

/**
 * GET /api/driver/trips
 * Get the driver's completed trips, most recent first, with pagination.
 */
const getTripHistory = async (req, res) => {
  try {
    const driverId = req.user.id;
    const parsedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const { startDate = null, endDate = null } = req.query;

    const query = { driverId };

    if (startDate || endDate) {
      query.journeyDate = {};
      if (startDate) query.journeyDate.$gte = new Date(startDate);
      if (endDate) query.journeyDate.$lte = new Date(endDate);
    }

    const trips = await DriverTrip.find(query)
      .populate('vehicleId', 'vehicleName registrationNumber')
      .populate('routeId', 'source destination')
      .sort({ journeyDate: -1 })
      .limit(parsedLimit)
      .skip((parsedPage - 1) * parsedLimit)
      .lean();

    const total = await DriverTrip.countDocuments(query);

    return res.json({
      trips,
      pagination: {
        currentPage: parsedPage,
        totalPages: Math.ceil(total / parsedLimit),
        totalTrips: total
      }
    });
  } catch (error) {
    console.error('Get trip history error:', error);
    res.status(500).json({ message: 'Failed to fetch trip history', error: error.message });
  }
};

/**
 * GET /api/driver/trips/:tripId
 * Get one of the driver's own trips.
 */
const getTripDetails = async (req, res) => {
  try {
    const { tripId } = req.params;
    const driverId = req.user.id;

    const trip = await DriverTrip.findOne({ _id: tripId, driverId })
      .populate('vehicleId')
      .populate('routeId')
      .lean();

    if (!trip) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    return res.json(trip);
  } catch (error) {
    console.error('Get trip details error:', error);
    res.status(500).json({ message: 'Failed to fetch trip details', error: error.message });
  }
};

/**
 * POST /api/driver/trips/log
 * Log a completed trip (typically called by admin/system).
 */
const logTrip = async (req, res) => {
  try {
    const {
      driverId,
      vehicleId,
      routeId,
      journeyDate,
      startTime,
      endTime,
      totalPassengers,
      totalDistance
    } = req.body;

    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    // Only the vehicle's assigned driver (logging their own trip), the
    // vehicle's managing manager, or a super-admin may log a trip for it —
    // otherwise any authenticated account could fabricate a trip record
    // (and downstream earnings/stats derived from it) for an arbitrary driver.
    const isOwningDriver =
      req.user.role === 'driver' &&
      vehicle.driverId && vehicle.driverId.toString() === req.user._id.toString() &&
      driverId === req.user._id.toString();
    const isOwningManager =
      req.user.role === 'admin' &&
      vehicle.managerId && vehicle.managerId.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === 'super-admin';

    if (!isOwningDriver && !isOwningManager && !isSuperAdmin) {
      return res.status(403).json({ message: 'Not authorized to log a trip for this vehicle' });
    }

    const tripId = `TRIP-${new Date().getTime()}-${vehicleId.slice(-4)}`;

    const trip = new DriverTrip({
      driverId,
      vehicleId,
      tripId,
      routeId,
      journeyDate: new Date(journeyDate),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      totalDistance,
      totalPassengers,
      status: 'ACTIVE'
    });

    await trip.save();
    await trip.populate(['vehicleId', 'routeId']);

    return res.status(201).json({
      message: 'Trip logged successfully',
      trip
    });
  } catch (error) {
    console.error('Log trip error:', error);
    res.status(500).json({ message: 'Failed to log trip', error: error.message });
  }
};

module.exports = {
  getTripHistory,
  getTripDetails,
  logTrip
};
