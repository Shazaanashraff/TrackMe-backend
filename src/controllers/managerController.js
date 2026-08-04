const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const LiveLocation = require('../models/LiveLocation');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const ManagerVehicleRequest = require('../models/ManagerVehicleRequest');
const Route = require('../models/Route');
const RouteChangeRequest = require('../models/RouteChangeRequest');
const Organization = require('../models/Organization');
const Driver = require('../models/Driver');
const { isEmailRegistered } = require('../utils/accountRegistry');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const VEHICLE_TYPES = ['AC', 'NON-AC', 'DELUXE', 'SLEEPER'];

const MANAGER_EDITABLE_FIELDS = [
  'vehicleName',
  'numberPlate',
  'registrationNumber',
  'seatCapacity',
  'vehicleType',
  'serviceType',
  'bookingEnabled',
  'routeId',
  'isActive',
  'maintenanceStatus'
];

const writeAuditLog = async ({ managerId, actorId, actorRole, action, entityType, entityId, metadata }) => {
  await ManagerAuditLog.create({
    managerId,
    actorId,
    actorRole,
    action,
    entityType,
    entityId,
    metadata
  });
};

const getManagedVehicleByVehicleId = async (managerId, vehicleId) => {
  return Vehicle.findOne({
    vehicleId,
    managerId,
    isDeleted: false
  });
};

exports.getManagerDashboard = async (req, res, next) => {
  try {
    const managerId = req.user._id;

    const [fleetStats, bookingStats, pendingRequests, driverIds] = await Promise.all([
      Vehicle.aggregate([
        { $match: { managerId, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalVehicles: { $sum: 1 },
            activeVehicles: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveVehicles: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
            bookingEnabledVehicles: { $sum: { $cond: [{ $eq: ['$bookingEnabled', true] }, 1, 0] } }
          }
        }
      ]),
      Booking.aggregate([
        {
          $lookup: {
            from: 'vehicles',
            localField: 'vehicleId',
            foreignField: '_id',
            as: 'vehicleInfo'
          }
        },
        { $unwind: '$vehicleInfo' },
        {
          $match: {
            isDeleted: false,
            'vehicleInfo.managerId': managerId
          }
        },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            confirmedBookings: { $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] } },
            cancelledBookings: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
            totalRevenue: {
              $sum: {
                $cond: [{ $eq: ['$status', 'CONFIRMED'] }, '$totalPrice', 0]
              }
            }
          }
        }
      ]),
      ManagerVehicleRequest.countDocuments({ managerId, status: 'PENDING' }),
      // Distinct drivers assigned across this manager's fleet — the headline metric
      // for private (school/office) managers who run many vehicles + drivers.
      Vehicle.distinct('driverId', { managerId, isDeleted: false, driverId: { $ne: null } })
    ]);

    const serviceType = req.user.serviceType || 'PUBLIC';
    let organizationName = null;
    if (serviceType !== 'PUBLIC' && req.user.organization) {
      const org = await Organization.findById(req.user.organization).select('name').lean();
      organizationName = org?.name || null;
    }

    return res.status(200).json({
      success: true,
      data: {
        serviceType,
        organizationName,
        driverCount: driverIds.length,
        fleet: fleetStats[0] || {
          totalVehicles: 0,
          activeVehicles: 0,
          inactiveVehicles: 0,
          bookingEnabledVehicles: 0
        },
        bookings: bookingStats[0] || {
          totalBookings: 0,
          confirmedBookings: 0,
          cancelledBookings: 0,
          totalRevenue: 0
        },
        pendingRequests
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerVehicles = async (req, res, next) => {
  try {
    const vehicles = await Vehicle.find({ managerId: req.user._id, isDeleted: false })
      .populate('driverId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerVehicleById = async (req, res, next) => {
  try {
    const vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found for this manager' });
    }

    const populated = await Vehicle.findById(vehicle._id).populate('driverId', 'name email').lean();

    return res.status(200).json({
      success: true,
      data: populated
    });
  } catch (error) {
    next(error);
  }
};

exports.updateManagerVehicle = async (req, res, next) => {
  try {
    const vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found for this manager' });
    }

    const incomingKeys = Object.keys(req.body || {});
    const blockedKey = incomingKeys.find((key) => !MANAGER_EDITABLE_FIELDS.includes(key));
    if (blockedKey) {
      return res.status(400).json({
        success: false,
        message: `Field '${blockedKey}' is not editable by manager`
      });
    }

    const updateData = {};
    for (const key of MANAGER_EDITABLE_FIELDS) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }

    if (updateData.serviceType) {
      updateData.serviceType = String(updateData.serviceType).toUpperCase();
      if (!SERVICE_TYPES.includes(updateData.serviceType)) {
        return res.status(400).json({ success: false, message: 'Invalid service type' });
      }
    }

    if (updateData.vehicleType) {
      updateData.vehicleType = String(updateData.vehicleType).toUpperCase();
      if (!VEHICLE_TYPES.includes(updateData.vehicleType)) {
        return res.status(400).json({ success: false, message: 'Invalid vehicle type' });
      }
    }

    if (updateData.numberPlate) {
      updateData.numberPlate = String(updateData.numberPlate).trim().toUpperCase();
      const duplicate = await Vehicle.findOne({
        numberPlate: updateData.numberPlate,
        _id: { $ne: vehicle._id },
        isDeleted: false
      });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'Number plate already exists' });
      }
    }

    if (updateData.routeId) {
      // A manager may assign a PUBLIC route or one of their own named (ACTIVE)
      // PRIVATE custom routes — never another manager's private route.
      const route = await Route.findOne({
        routeId: updateData.routeId,
        isDeleted: false,
        $or: [
          { visibility: 'PUBLIC' },
          { visibility: 'PRIVATE', managerId: req.user._id, status: 'ACTIVE' }
        ]
      });
      if (!route) {
        return res.status(400).json({ success: false, message: 'Invalid route ID' });
      }

      const effectiveServiceType = updateData.serviceType || vehicle.serviceType;
      if (route.serviceType && route.serviceType !== effectiveServiceType) {
        return res.status(400).json({
          success: false,
          message: 'Vehicle service type must match route service type'
        });
      }
    }

    const before = {
      vehicleName: vehicle.vehicleName,
      numberPlate: vehicle.numberPlate,
      registrationNumber: vehicle.registrationNumber,
      seatCapacity: vehicle.seatCapacity,
      vehicleType: vehicle.vehicleType,
      serviceType: vehicle.serviceType,
      bookingEnabled: vehicle.bookingEnabled,
      routeId: vehicle.routeId,
      isActive: vehicle.isActive,
      maintenanceStatus: vehicle.maintenanceStatus
    };

    Object.assign(vehicle, updateData);
    await vehicle.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'VEHICLE_EDITED',
      entityType: 'VEHICLE',
      entityId: vehicle.vehicleId,
      metadata: { before, after: updateData }
    });

    return res.status(200).json({
      success: true,
      message: 'Vehicle updated successfully',
      data: vehicle
    });
  } catch (error) {
    next(error);
  }
};

exports.createVehicleAccountRequest = async (req, res, next) => {
  try {
    const {
      vehicleId,
      vehicleName,
      numberPlate,
      routeId,
      routeMode,
      seatCapacity,
      vehicleType,
      serviceType,
      bookingEnabled,
      driverName,
      driverEmail,
      driverPhoneNumber,
      driverNicNumber,
      driverLicenseCardNumber,
      password,
      reason
    } = req.body;

    // CUSTOM = school/work shuttle whose driver records the route by driving it
    // (no existing route to pick). The backend provisions a private, unnamed
    // route for the vehicle at approval time instead of requiring a routeId here.
    const normalizedRouteMode = String(routeMode || 'EXISTING').toUpperCase();
    if (!['EXISTING', 'CUSTOM'].includes(normalizedRouteMode)) {
      return res.status(400).json({ success: false, message: 'routeMode must be EXISTING or CUSTOM' });
    }
    const isCustomRoute = normalizedRouteMode === 'CUSTOM';

    const normalizedVehicleId = String(vehicleId || '').trim();
    const normalizedNumberPlate = String(numberPlate || '').trim().toUpperCase();
    const normalizedReg = String(req.body?.registrationNumber || `AUTO-${normalizedVehicleId}`).trim();
    const normalizedRouteId = String(routeId || '').trim();
    const normalizedEmail = String(driverEmail || '').trim().toLowerCase();

    if (!normalizedVehicleId || !normalizedNumberPlate || (!isCustomRoute && !normalizedRouteId) || !driverName || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: isCustomRoute
          ? 'vehicleId, numberPlate, driverName, driverEmail, and password are required'
          : 'vehicleId, numberPlate, routeId, driverName, driverEmail, and password are required'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const existingVehicle = await Vehicle.findOne({
      $or: [{ vehicleId: normalizedVehicleId }, { registrationNumber: normalizedReg }, { numberPlate: normalizedNumberPlate }],
      isDeleted: false
    });
    if (existingVehicle) {
      return res.status(409).json({
        success: false,
        message: 'Vehicle ID, number plate, or registration number already exists'
      });
    }

    const existingDriverAccount = await Driver.findOne({ email: normalizedEmail });
    if (!existingDriverAccount) {
      const takenByOtherAccountType = await isEmailRegistered(normalizedEmail);
      if (takenByOtherAccountType) {
        return res.status(409).json({
          success: false,
          message: 'Email already exists on a non-driver account'
        });
      }
    }

    let route = null;
    if (!isCustomRoute) {
      route = await Route.findOne({ routeId: normalizedRouteId, isDeleted: false });
      if (!route) {
        return res.status(400).json({ success: false, message: 'Invalid route ID' });
      }
    }

    const normalizedServiceType = String(serviceType || route?.serviceType || 'PUBLIC').toUpperCase();
    if (!SERVICE_TYPES.includes(normalizedServiceType)) {
      return res.status(400).json({ success: false, message: 'Invalid service type' });
    }

    if (route?.serviceType && route.serviceType !== normalizedServiceType) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle service type must match route service type'
      });
    }

    const pendingForVehicle = await ManagerVehicleRequest.findOne({
      managerId: req.user._id,
      vehicleId: normalizedVehicleId,
      status: 'PENDING',
      type: 'CREATE_VEHICLE_ACCOUNT'
    });

    if (pendingForVehicle) {
      return res.status(409).json({
        success: false,
        message: 'A pending create request already exists for this vehicle ID'
      });
    }

    const requestDoc = await ManagerVehicleRequest.create({
      type: 'CREATE_VEHICLE_ACCOUNT',
      managerId: req.user._id,
      vehicleId: normalizedVehicleId,
      reason: String(reason || '').trim(),
      payload: {
        routeMode: normalizedRouteMode,
        vehicle: {
          vehicleId: normalizedVehicleId,
          vehicleName,
          numberPlate: normalizedNumberPlate,
          registrationNumber: normalizedReg,
          // routeId is left unset for CUSTOM; the super admin approval step
          // provisions a private route and fills this in before Vehicle.create.
          routeId: isCustomRoute ? undefined : normalizedRouteId,
          seatCapacity,
          vehicleType: vehicleType || 'AC',
          serviceType: normalizedServiceType,
          bookingEnabled: bookingEnabled !== undefined ? Boolean(bookingEnabled) : true
        },
        driver: {
          name: String(driverName).trim(),
          email: normalizedEmail,
          phoneNumber: String(driverPhoneNumber || '').trim(),
          nicNumber: String(driverNicNumber || '').trim(),
          licenseCardNumber: String(driverLicenseCardNumber || '').trim(),
          password
        }
      }
    });

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'VEHICLE_CREATE_REQUESTED',
      entityType: 'VEHICLE_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: {
        vehicleId: normalizedVehicleId,
        routeId: normalizedRouteId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Vehicle creation request submitted for super admin approval',
      data: requestDoc
    });
  } catch (error) {
    next(error);
  }
};

exports.requestVehicleDelete = async (req, res, next) => {
  try {
    const vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found for this manager' });
    }

    const existingPendingDelete = await ManagerVehicleRequest.findOne({
      managerId: req.user._id,
      vehicleId: vehicle.vehicleId,
      type: 'DELETE_VEHICLE',
      status: 'PENDING'
    });
    if (existingPendingDelete) {
      return res.status(409).json({ success: false, message: 'A pending delete request already exists for this vehicle' });
    }

    const requestDoc = await ManagerVehicleRequest.create({
      type: 'DELETE_VEHICLE',
      managerId: req.user._id,
      vehicleId: vehicle.vehicleId,
      reason: String(req.body?.reason || '').trim(),
      payload: {
        vehicleSnapshot: {
          vehicleId: vehicle.vehicleId,
          vehicleName: vehicle.vehicleName,
          registrationNumber: vehicle.registrationNumber,
          routeId: vehicle.routeId
        }
      }
    });

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'VEHICLE_DELETE_REQUESTED',
      entityType: 'VEHICLE_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: { vehicleId: vehicle.vehicleId }
    });

    return res.status(201).json({
      success: true,
      message: 'Vehicle deletion request submitted for super admin approval',
      data: requestDoc
    });
  } catch (error) {
    next(error);
  }
};

exports.getMyRequests = async (req, res, next) => {
  try {
    const requests = await ManagerVehicleRequest.find({ managerId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests
    });
  } catch (error) {
    next(error);
  }
};

exports.resetVehicleAccountPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found for this manager' });
    }

    const driver = await Driver.findById(vehicle.driverId).select('+password');
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver account not found for this vehicle' });
    }

    driver.password = password;
    driver.isEmailVerified = true;
    driver.isActive = true;
    await driver.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'VEHICLE_ACCOUNT_PASSWORD_RESET',
      entityType: 'VEHICLE_ACCOUNT',
      entityId: vehicle.vehicleId,
      metadata: { driverId: driver._id }
    });

    return res.status(200).json({
      success: true,
      message: 'Vehicle account password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerVehicleLocation = async (req, res, next) => {
  try {
    const vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found for this manager' });
    }

    const minutes = Number(req.query.minutes) || 15;
    const allowedMinutes = [15, 30, 60];
    const windowMinutes = allowedMinutes.includes(minutes) ? minutes : 15;
    const startTime = new Date(Date.now() - windowMinutes * 60 * 1000);

    const [latest, history] = await Promise.all([
      LiveLocation.findOne({ vehicleId: vehicle.vehicleId }).sort({ timestamp: -1 }).lean(),
      LiveLocation.find({ vehicleId: vehicle.vehicleId, timestamp: { $gte: startTime } })
        .sort({ timestamp: 1 })
        .lean()
    ]);

    return res.status(200).json({
      success: true,
      data: {
        vehicle: {
          vehicleId: vehicle.vehicleId,
          vehicleName: vehicle.vehicleName,
          routeId: vehicle.routeId
        },
        latest,
        history,
        windowMinutes
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List this manager's driver-recorded custom routes
// @route   GET /api/manager/custom-routes?status=PENDING_NAMING|ACTIVE
exports.getManagerCustomRoutes = async (req, res, next) => {
  try {
    const filter = { managerId: req.user._id, origin: 'RECORDED', isDeleted: false };

    const status = String(req.query.status || '').toUpperCase();
    if (['ACTIVE', 'PENDING_NAMING'].includes(status)) {
      filter.status = status;
    }

    const routes = await Route.find(filter).sort({ createdAt: -1 }).lean();

    return res.status(200).json({ success: true, count: routes.length, data: routes });
  } catch (error) {
    next(error);
  }
};

// @desc    Name a driver-recorded custom route, activating it for reuse
// @route   PATCH /api/manager/custom-routes/:routeId/name
exports.nameCustomRoute = async (req, res, next) => {
  try {
    const routeName = String(req.body?.routeName || '').trim();
    if (!routeName) {
      return res.status(400).json({ success: false, message: 'routeName is required' });
    }

    const route = await Route.findOne({
      routeId: req.params.routeId,
      managerId: req.user._id,
      origin: 'RECORDED',
      isDeleted: false
    });
    if (!route) {
      return res.status(404).json({ success: false, message: 'Custom route not found for this manager' });
    }

    if (!route.pathPolyline) {
      return res.status(409).json({ success: false, message: 'Route has not been recorded yet' });
    }

    route.routeName = routeName;
    route.status = 'ACTIVE';
    await route.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'CUSTOM_ROUTE_NAMED',
      entityType: 'ROUTE',
      entityId: route.routeId,
      metadata: { routeName }
    });

    return res.status(200).json({ success: true, message: 'Route named and activated', data: route });
  } catch (error) {
    next(error);
  }
};

// @desc    Routes available for this manager to assign to a vehicle: public routes
//          plus this manager's own named (ACTIVE) private custom routes.
// @route   GET /api/manager/routes
exports.getManagerAssignableRoutes = async (req, res, next) => {
  try {
    const routes = await Route.find({
      isDeleted: false,
      isActive: true,
      $or: [
        { visibility: 'PUBLIC' },
        { visibility: 'PRIVATE', managerId: req.user._id, status: 'ACTIVE' }
      ]
    }).select('routeId routeName source destination fare estimatedTime serviceType distance stopsCount stops visibility');

    return res.status(200).json({ success: true, count: routes.length, data: routes });
  } catch (error) {
    next(error);
  }
};

// @desc    List this manager's route-change requests (off-route flags / driver updates)
// @route   GET /api/manager/route-change-requests?status=PENDING
exports.getManagerRouteChangeRequests = async (req, res, next) => {
  try {
    const filter = { managerId: req.user._id };

    const status = String(req.query.status || '').toUpperCase();
    if (['PENDING', 'RESOLVED'].includes(status)) {
      filter.status = status;
    }

    const requests = await RouteChangeRequest.find(filter)
      .populate('currentRouteId', 'routeId routeName pathPolyline stops distance')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: requests.length, data: requests });
  } catch (error) {
    next(error);
  }
};

// @desc    Resolve a route-change request: keep the current route, or adopt
//          the driver-recorded candidate as the route's new geometry.
// @route   PATCH /api/manager/route-change-requests/:id/resolve
exports.resolveRouteChangeRequest = async (req, res, next) => {
  try {
    const resolution = String(req.body?.resolution || '').toUpperCase();
    if (!['KEEP_OLD', 'ADOPT_NEW'].includes(resolution)) {
      return res.status(400).json({ success: false, message: 'resolution must be KEEP_OLD or ADOPT_NEW' });
    }

    const changeRequest = await RouteChangeRequest.findOne({ _id: req.params.id, managerId: req.user._id });
    if (!changeRequest) {
      return res.status(404).json({ success: false, message: 'Route change request not found' });
    }

    // Idempotent: a request already resolved (e.g. by a concurrent action) is
    // returned as-is rather than reprocessed.
    if (changeRequest.status === 'RESOLVED') {
      return res.status(200).json({ success: true, message: 'Already resolved', data: changeRequest });
    }

    if (resolution === 'ADOPT_NEW') {
      const route = await Route.findById(changeRequest.currentRouteId);
      if (!route) {
        return res.status(404).json({ success: false, message: 'The route this request refers to no longer exists' });
      }
      route.pathPolyline = changeRequest.candidate.pathPolyline;
      if (changeRequest.candidate.stops?.length) {
        route.stops = changeRequest.candidate.stops;
        route.stopsCount = changeRequest.candidate.stops.length;
      }
      route.distance = changeRequest.candidate.distance;
      await route.save();
    }

    changeRequest.status = 'RESOLVED';
    changeRequest.resolution = resolution;
    await changeRequest.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROUTE_CHANGE_REQUEST_RESOLVED',
      entityType: 'ROUTE_CHANGE_REQUEST',
      entityId: changeRequest._id.toString(),
      metadata: { resolution }
    });

    return res.status(200).json({ success: true, message: 'Route change request resolved', data: changeRequest });
  } catch (error) {
    next(error);
  }
};
