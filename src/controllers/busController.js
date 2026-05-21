const mongoose = require('mongoose');
const Bus = require('../models/Bus');
const Route = require('../models/Route');

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
      .select('routeId routeName source destination fare estimatedTime serviceType');

    res.status(200).json({
      success: true,
      count: routes.length,
      data: routes
    });
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
