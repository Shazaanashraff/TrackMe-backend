const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const { nearestStop, segmentDistanceKm } = require('../utils/geo');
const { formatPlate, PLATE_FORMAT_MESSAGE } = require('../utils/numberPlate');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

const parseBooleanQuery = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

// @desc    Register a new vehicle (driver only)
// @route   POST /api/vehicle/register
exports.registerVehicle = async (req, res, next) => {
  try {
    const { vehicleId, vehicleName, registrationNumber, numberPlate, routeId, seatCapacity, vehicleType, serviceType, bookingEnabled } = req.body;
    const plateInput = numberPlate || registrationNumber || '';
    const normalizedNumberPlate = formatPlate(plateInput);

    if (!normalizedNumberPlate) {
      return res.status(400).json({ success: false, message: PLATE_FORMAT_MESSAGE });
    }

    // Check if vehicle exists
    const vehicleExists = await Vehicle.findOne({ $or: [{ vehicleId }, { registrationNumber }, { numberPlate: normalizedNumberPlate }], isDeleted: false });
    if (vehicleExists) {
      return res.status(400).json({ 
        success: false, 
        message: vehicleExists.vehicleId === vehicleId ? 'Vehicle ID already registered' : 'Vehicle registration details already exist' 
      });
    }

    // Verify route exists — self-registration may only target a PUBLIC route;
    // a manager's PRIVATE custom route is assigned only via the manager flow.
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
        message: 'Vehicle service type must match route service type'
      });
    }

    // Create vehicle with driver's ID
    const vehicle = await Vehicle.create({
      vehicleId,
      vehicleName,
      registrationNumber,
      numberPlate: normalizedNumberPlate,
      routeId,
      seatCapacity,
      vehicleType: vehicleType || 'AC',
      serviceType: normalizedServiceType,
      bookingEnabled: bookingEnabled !== undefined ? Boolean(bookingEnabled) : true,
      driverId: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Vehicle registered successfully',
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get vehicles by route
// @route   GET /api/vehicle/route/:routeId
exports.getVehiclesByRoute = async (req, res, next) => {
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

    // A manager's PRIVATE route (custom shuttle, or a Private Routes feature route)
    // Filter vehicles by effective route lookup
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

    const vehicles = await Vehicle.find(filter)
      .populate('driverId', 'name email')
      .select('vehicleId vehicleName seatCapacity vehicleType serviceType bookingEnabled isActive maintenanceStatus');

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all routes (distinct routeIds)
// @route   GET /api/vehicle/routes
exports.getAllRoutes = async (req, res, next) => {
  try {
    const { serviceType } = req.query;
    // Unauthenticated endpoint — never surface a manager's PRIVATE custom route.
    const filter = { isDeleted: false, isActive: true };

    if (serviceType && SERVICE_TYPES.includes(String(serviceType).toUpperCase())) {
      filter.serviceType = String(serviceType).toUpperCase();
    }

    const routes = await Route.find(filter)
      .select('routeId routeName source destination fare estimatedTime serviceType distance stopsCount stops simVehicleCount');

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
// @route   GET /api/vehicle/stops
exports.getStops = async (req, res, next) => {
  try {
    // Unauthenticated endpoint — never leak a manager's PRIVATE custom-route stops.
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
// @route   GET /api/vehicle/routes/plan?fromLat&fromLng&toLat&toLng[&maxWalkKm&serviceType]
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

    // Unauthenticated endpoint — journey planning must never surface a manager's
    // PRIVATE custom route.
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

    // Best first: least total walking, then fewest stops on the vehicle.
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

// @desc    Get driver's vehicle
// @route   GET /api/vehicle/my-vehicle
exports.getMyVehicle = async (req, res, next) => {
  try {
    const vehicle = await Vehicle.findOne({ driverId: req.user._id, isDeleted: false })
      .populate('driverId', 'name email');

    if (!vehicle) {
      return res.status(404).json({ 
        success: false, 
        message: 'No vehicle assigned to this driver' 
      });
    }

    res.status(200).json({
      success: true,
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single vehicle by ID
// @route   GET /api/vehicle/:vehicleId
exports.getVehicleById = async (req, res, next) => {
  try {
    const { vehicleId } = req.params;

    const vehicle = await Vehicle.findOne({ vehicleId, isDeleted: false })
      .populate('driverId', 'name email');

    if (!vehicle) {
      return res.status(404).json({ 
        success: false, 
        message: 'Vehicle not found' 
      });
    }

    res.status(200).json({
      success: true,
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update vehicle details (admin/driver only)
// @route   PUT /api/vehicle/:vehicleId
exports.updateVehicle = async (req, res, next) => {
  try {
    const { vehicleId } = req.params;
    const updateData = { ...req.body };

    const vehicle = await Vehicle.findOne({ vehicleId, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ 
        success: false, 
        message: 'Vehicle not found' 
      });
    }

    // Driver can update own vehicle, manager can update assigned vehicles, super-admin can update all.
    if (
      vehicle.driverId.toString() !== req.user._id.toString() &&
      !(req.user.role === 'admin' && vehicle.managerId && vehicle.managerId.toString() === req.user._id.toString()) &&
      req.user.role !== 'super-admin'
    ) {
      return res.status(403).json({ 
        success: false, 
        message: 'Not authorized to update this vehicle' 
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
      // A PRIVATE custom route may only be assigned by its owning manager
      // (driver self-service and other managers are limited to PUBLIC routes).
      const route = await Route.findOne({
        routeId: updateData.routeId,
        isDeleted: false
      });
      if (!route) {
        return res.status(400).json({
          success: false,
          message: 'Invalid route ID'
        });
      }

      const incomingServiceType = updateData.serviceType || vehicle.serviceType;
      if (route.serviceType && route.serviceType !== incomingServiceType) {
        return res.status(400).json({
          success: false,
          message: 'Vehicle service type must match route service type'
        });
      }
    }

    Object.assign(vehicle, updateData);
    await vehicle.save();

    res.status(200).json({
      success: true,
      message: 'Vehicle updated successfully',
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete vehicle (soft delete)
// @route   DELETE /api/vehicle/:vehicleId
exports.deleteVehicle = async (req, res, next) => {
  try {
    const { vehicleId } = req.params;

    const vehicle = await Vehicle.findOne({ vehicleId, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ 
        success: false, 
        message: 'Vehicle not found' 
      });
    }

    const isOwnerDriver = vehicle.driverId.toString() === req.user._id.toString();
    const isAssignedManager = req.user.role === 'admin' && vehicle.managerId && vehicle.managerId.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === 'super-admin';

    if (!isOwnerDriver && !isAssignedManager && !isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this vehicle'
      });
    }

    vehicle.isDeleted = true;
    vehicle.isActive = false;
    await vehicle.save();

    res.status(200).json({
      success: true,
      message: 'Vehicle deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all vehicles with pagination
// @route   GET /api/vehicle/list/all
exports.getAllVehicles = async (req, res, next) => {
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

    const vehicles = await Vehicle.find(filter)
      .populate('driverId', 'name email')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await Vehicle.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: vehicles,
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

// @desc    Update vehicle maintenance status
// @route   PATCH /api/vehicle/:vehicleId/maintenance
exports.updateMaintenanceStatus = async (req, res, next) => {
  try {
    const { vehicleId } = req.params;
    const { maintenanceStatus, nextServiceDate } = req.body;

    const vehicle = await Vehicle.findOne({ vehicleId, isDeleted: false });
    if (!vehicle) {
      return res.status(404).json({ 
        success: false, 
        message: 'Vehicle not found' 
      });
    }

    vehicle.maintenanceStatus = maintenanceStatus;
    if (maintenanceStatus === 'MAINTENANCE' && !vehicle.lastServiceDate) {
      vehicle.lastServiceDate = new Date();
    }
    if (nextServiceDate) {
      vehicle.nextServiceDate = nextServiceDate;
    }

    await vehicle.save();

    res.status(200).json({
      success: true,
      message: 'Maintenance status updated',
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get vehicles statistics
// @route   GET /api/vehicle/stats/overview
exports.getVehiclesStats = async (req, res, next) => {
  try {
    const totalVehicles = await Vehicle.countDocuments({ isDeleted: false });
    const activeVehicles = await Vehicle.countDocuments({ isDeleted: false, isActive: true });
    const maintenanceVehicles = await Vehicle.countDocuments({ isDeleted: false, maintenanceStatus: 'MAINTENANCE' });

    const totalCapacity = await Vehicle.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$seatCapacity' } } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalVehicles,
        activeVehicles,
        maintenanceVehicles,
        totalCapacity: totalCapacity[0]?.total || 0
      }
    });
  } catch (error) {
    next(error);
  }
};
