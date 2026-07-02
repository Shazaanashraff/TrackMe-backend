const mongoose = require('mongoose');
const Bus = require('../models/Bus');
const Route = require('../models/Route');
const { nearestStop, segmentDistanceKm } = require('../utils/geo');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

const parseBooleanQuery = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

// @desc    Register a new bus (driver only)
// @route   POST /api/bus/register
exports.registerBus = async (req, res, next) => {
  try {
    const { busId, busName, registrationNumber, numberPlate, routeId, seatCapacity, busType, serviceType, bookingEnabled } = req.body;
    const normalizedNumberPlate = String(numberPlate || registrationNumber || '').trim().toUpperCase();

    // Check if bus exists
    const busExists = await Bus.findOne({ $or: [{ busId }, { registrationNumber }, { numberPlate: normalizedNumberPlate }], isDeleted: false });
    if (busExists) {
      return res.status(400).json({ 
        success: false, 
        message: busExists.busId === busId ? 'Bus ID already registered' : 'Bus registration details already exist' 
      });
    }

    // Verify route exists
    const routeExists = await Route.findOne({ routeId, isDeleted: false });
    if (!routeExists) {
      return res.status(400).json({
        success: false,
        message: 'Invalid route ID'
      });
    }

    const normalizedServiceType = (serviceType || routeExists.serviceType || 'PUBLIC').toUpperCase();
    if (!SERVICE_TYPES.includes(normalizedServiceType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service type'
      });
    }

    if (routeExists.serviceType && routeExists.serviceType !== normalizedServiceType) {
      return res.status(400).json({
        success: false,
        message: 'Bus service type must match route service type'
      });
    }

    // Create bus with driver's ID
    const bus = await Bus.create({
      busId,
      busName,
      registrationNumber,
      numberPlate: normalizedNumberPlate,
      routeId,
      seatCapacity,
      busType: busType || 'AC',
      serviceType: normalizedServiceType,
      bookingEnabled: bookingEnabled !== undefined ? Boolean(bookingEnabled) : true,
      driverId: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Bus registered successfully',
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get buses by route
// @route   GET /api/bus/route/:routeId
exports.getBusesByRoute = async (req, res, next) => {
  try {
    const { routeId } = req.params;
    const { serviceType, bookingEnabled } = req.query;

    // Build filter supporting both business routeId and MongoDB ObjectId
    const filter = { isDeleted: false };
    const routeFilters = [{ routeId }];
    if (mongoose.Types.ObjectId.isValid(routeId)) {
      routeFilters.push({ routeId: routeId }); // In case routeId is stored as raw ObjectId string
    }

    // Try to find route by routeId (business code) or Mongo ObjectId
    const route = await Route.findOne({
      $or: [{ routeId }, ...(mongoose.Types.ObjectId.isValid(routeId) ? [{ _id: routeId }] : [])]
    });

    // Filter buses by effective route lookup
    if (route) {
      filter.routeId = route.routeId;
    } else {
      // Fallback: accept the input routeId string as-is
      filter.routeId = routeId;
    }

    if (serviceType && SERVICE_TYPES.includes(String(serviceType).toUpperCase())) {
      filter.serviceType = String(serviceType).toUpperCase();
    }

    const parsedBookingEnabled = parseBooleanQuery(bookingEnabled);
    if (parsedBookingEnabled !== undefined) {
      filter.bookingEnabled = parsedBookingEnabled;
    }

    const buses = await Bus.find(filter)
      .populate('driverId', 'name email')
      .select('busId busName seatCapacity busType serviceType bookingEnabled isActive maintenanceStatus');

    res.status(200).json({
      success: true,
      count: buses.length,
      data: buses
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all routes (distinct routeIds)
// @route   GET /api/bus/routes
exports.getAllRoutes = async (req, res, next) => {
  try {
    const { serviceType } = req.query;
    const filter = { isDeleted: false, isActive: true };

    if (serviceType && SERVICE_TYPES.includes(String(serviceType).toUpperCase())) {
      filter.serviceType = String(serviceType).toUpperCase();
    }

    const routes = await Route.find(filter)
      .select('routeId routeName source destination fare estimatedTime serviceType distance stopsCount stops simBusCount');

    res.status(200).json({
      success: true,
      count: routes.length,
      data: routes
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Flat list of every unique stop (for From/To autocomplete + snapping)
// @route   GET /api/bus/stops
exports.getStops = async (req, res, next) => {
  try {
    const routes = await Route.find({ isDeleted: false, isActive: true }).select('stops');

    // Dedupe by stop name (case-insensitive); first coordinates win.
    const seen = new Map();
    for (const route of routes) {
      for (const stop of route.stops || []) {
        if (!stop?.stopName || typeof stop.lat !== 'number' || typeof stop.lng !== 'number') continue;
        const key = stop.stopName.trim().toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, { stopName: stop.stopName.trim(), lat: stop.lat, lng: stop.lng });
        }
      }
    }

    const stops = [...seen.values()].sort((a, b) => a.stopName.localeCompare(b.stopName));
    res.status(200).json({ success: true, count: stops.length, data: stops });
  } catch (error) {
    next(error);
  }
};

// @desc    Plan a trip: which direct routes carry a rider from -> to
// @route   GET /api/bus/routes/plan?fromLat&fromLng&toLat&toLng[&maxWalkKm&serviceType]
exports.planJourney = async (req, res, next) => {
  try {
    const fromLat = Number(req.query.fromLat);
    const fromLng = Number(req.query.fromLng);
    const toLat = Number(req.query.toLat);
    const toLng = Number(req.query.toLng);

    const coords = [fromLat, fromLng, toLat, toLng];
    if (coords.some((n) => !Number.isFinite(n))) {
      return res.status(400).json({
        success: false,
        message: 'fromLat, fromLng, toLat and toLng are required numeric query params',
      });
    }

    // How far a rider is willing to walk to/from a stop (km). Clamp to a sane range.
    const maxWalkKm = Math.min(Math.max(Number(req.query.maxWalkKm) || 2, 0.1), 20);

    const filter = { isDeleted: false, isActive: true };
    if (req.query.serviceType && SERVICE_TYPES.includes(String(req.query.serviceType).toUpperCase())) {
      filter.serviceType = String(req.query.serviceType).toUpperCase();
    }

    const routes = await Route.find(filter)
      .select('routeId routeName source destination fare estimatedTime serviceType distance stopsCount stops');

    const matches = [];
    for (const route of routes) {
      const stops = (route.stops || [])
        .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (stops.length < 2) continue;

      const origin = nearestStop(stops, fromLat, fromLng);
      const dest = nearestStop(stops, toLat, toLng);
      if (!origin || !dest) continue;
      if (origin.distanceKm > maxWalkKm || dest.distanceKm > maxWalkKm) continue;
      // Direction matters: board stop must come BEFORE alight stop on the route.
      if (origin.index >= dest.index) continue;

      const rideKm = segmentDistanceKm(stops, origin.index, dest.index);
      const totalKm = route.distance || segmentDistanceKm(stops, 0, stops.length - 1);
      // Prorate the route fare by the portion of the route actually ridden.
      const fareEstimate =
        totalKm > 0 && route.fare ? Math.round((route.fare * rideKm) / totalKm) : route.fare || null;

      matches.push({
        routeId: route.routeId,
        routeName: route.routeName,
        source: route.source,
        destination: route.destination,
        serviceType: route.serviceType,
        boardStop: { stopName: origin.stop.stopName, lat: origin.stop.lat, lng: origin.stop.lng },
        alightStop: { stopName: dest.stop.stopName, lat: dest.stop.lat, lng: dest.stop.lng },
        stopsBetween: dest.index - origin.index,
        rideDistanceKm: Math.round(rideKm * 10) / 10,
        walkToBoardKm: Math.round(origin.distanceKm * 100) / 100,
        walkFromAlightKm: Math.round(dest.distanceKm * 100) / 100,
        fareEstimate,
      });
    }

    // Best first: least total walking, then fewest stops on the bus.
    matches.sort((a, b) => {
      const walkA = a.walkToBoardKm + a.walkFromAlightKm;
      const walkB = b.walkToBoardKm + b.walkFromAlightKm;
      if (walkA !== walkB) return walkA - walkB;
      return a.stopsBetween - b.stopsBetween;
    });

    res.status(200).json({ success: true, count: matches.length, data: matches });
  } catch (error) {
    next(error);
  }
};

// @desc    Get driver's bus
// @route   GET /api/bus/my-bus
exports.getMyBus = async (req, res, next) => {
  try {
    const bus = await Bus.findOne({ driverId: req.user._id, isDeleted: false })
      .populate('driverId', 'name email');

    if (!bus) {
      return res.status(404).json({ 
        success: false, 
        message: 'No bus assigned to this driver' 
      });
    }

    res.status(200).json({
      success: true,
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single bus by ID
// @route   GET /api/bus/:busId
exports.getBusById = async (req, res, next) => {
  try {
    const { busId } = req.params;

    const bus = await Bus.findOne({ busId, isDeleted: false })
      .populate('driverId', 'name email');

    if (!bus) {
      return res.status(404).json({ 
        success: false, 
        message: 'Bus not found' 
      });
    }

    res.status(200).json({
      success: true,
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update bus details (admin/driver only)
// @route   PUT /api/bus/:busId
exports.updateBus = async (req, res, next) => {
  try {
    const { busId } = req.params;
    const updateData = { ...req.body };

    const bus = await Bus.findOne({ busId, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ 
        success: false, 
        message: 'Bus not found' 
      });
    }

    // Driver can update own bus, manager can update assigned buses, super-admin can update all.
    if (
      bus.driverId.toString() !== req.user._id.toString() &&
      !(req.user.role === 'admin' && bus.managerId && bus.managerId.toString() === req.user._id.toString()) &&
      req.user.role !== 'super-admin'
    ) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized to update this bus' 
      });
    }

    if (updateData.serviceType) {
      updateData.serviceType = String(updateData.serviceType).toUpperCase();
      if (!SERVICE_TYPES.includes(updateData.serviceType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid service type'
        });
      }
    }

    if (updateData.routeId) {
      const route = await Route.findOne({ routeId: updateData.routeId, isDeleted: false });
      if (!route) {
        return res.status(400).json({
          success: false,
          message: 'Invalid route ID'
        });
      }

      const incomingServiceType = updateData.serviceType || bus.serviceType;
      if (route.serviceType && route.serviceType !== incomingServiceType) {
        return res.status(400).json({
          success: false,
          message: 'Bus service type must match route service type'
        });
      }
    }

    Object.assign(bus, updateData);
    await bus.save();

    res.status(200).json({
      success: true,
      message: 'Bus updated successfully',
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete bus (soft delete)
// @route   DELETE /api/bus/:busId
exports.deleteBus = async (req, res, next) => {
  try {
    const { busId } = req.params;

    const bus = await Bus.findOne({ busId, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ 
        success: false, 
        message: 'Bus not found' 
      });
    }

    const isOwnerDriver = bus.driverId.toString() === req.user._id.toString();
    const isAssignedManager = req.user.role === 'admin' && bus.managerId && bus.managerId.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === 'super-admin';

    if (!isOwnerDriver && !isAssignedManager && !isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this bus'
      });
    }

    bus.isDeleted = true;
    bus.isActive = false;
    await bus.save();

    res.status(200).json({
      success: true,
      message: 'Bus deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all buses with pagination
// @route   GET /api/bus/list/all
exports.getAllBuses = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = { isDeleted: false };
    if (req.query.routeId) filter.routeId = req.query.routeId;
    if (req.query.maintenanceStatus) filter.maintenanceStatus = req.query.maintenanceStatus;
    if (req.query.serviceType && SERVICE_TYPES.includes(String(req.query.serviceType).toUpperCase())) {
      filter.serviceType = String(req.query.serviceType).toUpperCase();
    }

    const parsedBookingEnabled = parseBooleanQuery(req.query.bookingEnabled);
    if (parsedBookingEnabled !== undefined) {
      filter.bookingEnabled = parsedBookingEnabled;
    }

    const buses = await Bus.find(filter)
      .populate('driverId', 'name email')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await Bus.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: buses,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update bus maintenance status
// @route   PATCH /api/bus/:busId/maintenance
exports.updateMaintenanceStatus = async (req, res, next) => {
  try {
    const { busId } = req.params;
    const { maintenanceStatus, nextServiceDate } = req.body;

    const bus = await Bus.findOne({ busId, isDeleted: false });
    if (!bus) {
      return res.status(404).json({ 
        success: false, 
        message: 'Bus not found' 
      });
    }

    bus.maintenanceStatus = maintenanceStatus;
    if (maintenanceStatus === 'MAINTENANCE' && !bus.lastServiceDate) {
      bus.lastServiceDate = new Date();
    }
    if (nextServiceDate) {
      bus.nextServiceDate = nextServiceDate;
    }

    await bus.save();

    res.status(200).json({
      success: true,
      message: 'Maintenance status updated',
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get buses statistics
// @route   GET /api/bus/stats/overview
exports.getBusesStats = async (req, res, next) => {
  try {
    const totalBuses = await Bus.countDocuments({ isDeleted: false });
    const activeBuses = await Bus.countDocuments({ isDeleted: false, isActive: true });
    const maintenanceBuses = await Bus.countDocuments({ isDeleted: false, maintenanceStatus: 'MAINTENANCE' });

    const totalCapacity = await Bus.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$seatCapacity' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalBuses,
        activeBuses,
        maintenanceBuses,
        totalCapacity: totalCapacity[0]?.total || 0
      }
    });
  } catch (error) {
    next(error);
  }
};
