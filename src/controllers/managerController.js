const Bus = require('../models/Bus');
const Booking = require('../models/Booking');
const LiveLocation = require('../models/LiveLocation');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const ManagerBusRequest = require('../models/ManagerBusRequest');
const Route = require('../models/Route');
const RouteChangeRequest = require('../models/RouteChangeRequest');
const User = require('../models/User');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const BUS_TYPES = ['AC', 'NON-AC', 'DELUXE', 'SLEEPER'];

const MANAGER_EDITABLE_FIELDS = [
  'busName',
  'numberPlate',
  'registrationNumber',
  'seatCapacity',
  'busType',
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

const getManagedBusByBusId = async (managerId, busId) => {
  return Bus.findOne({
    busId,
    managerId,
    isDeleted: false
  });
};

exports.getManagerDashboard = async (req, res, next) => {
  try {
    const managerId = req.user._id;

    const [fleetStats, bookingStats, pendingRequests] = await Promise.all([
      Bus.aggregate([
        { $match: { managerId, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalBuses: { $sum: 1 },
            activeBuses: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveBuses: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
            bookingEnabledBuses: { $sum: { $cond: [{ $eq: ['$bookingEnabled', true] }, 1, 0] } }
          }
        }
      ]),
      Booking.aggregate([
        {
          $lookup: {
            from: 'buses',
            localField: 'busId',
            foreignField: '_id',
            as: 'busInfo'
          }
        },
        { $unwind: '$busInfo' },
        {
          $match: {
            isDeleted: false,
            'busInfo.managerId': managerId
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
      ManagerBusRequest.countDocuments({ managerId, status: 'PENDING' })
    ]);

    return res.status(200).json({
      success: true,
      data: {
        fleet: fleetStats[0] || {
          totalBuses: 0,
          activeBuses: 0,
          inactiveBuses: 0,
          bookingEnabledBuses: 0
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

exports.getManagerBuses = async (req, res, next) => {
  try {
    const buses = await Bus.find({ managerId: req.user._id, isDeleted: false })
      .populate('driverId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: buses.length,
      data: buses
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerBusById = async (req, res, next) => {
  try {
    const bus = await getManagedBusByBusId(req.user._id, req.params.busId);

    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found for this manager' });
    }

    const populated = await Bus.findById(bus._id).populate('driverId', 'name email').lean();

    return res.status(200).json({
      success: true,
      data: populated
    });
  } catch (error) {
    next(error);
  }
};

exports.updateManagerBus = async (req, res, next) => {
  try {
    const bus = await getManagedBusByBusId(req.user._id, req.params.busId);

    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found for this manager' });
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

    if (updateData.busType) {
      updateData.busType = String(updateData.busType).toUpperCase();
      if (!BUS_TYPES.includes(updateData.busType)) {
        return res.status(400).json({ success: false, message: 'Invalid bus type' });
      }
    }

    if (updateData.numberPlate) {
      updateData.numberPlate = String(updateData.numberPlate).trim().toUpperCase();
      const duplicate = await Bus.findOne({
        numberPlate: updateData.numberPlate,
        _id: { $ne: bus._id },
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

      const effectiveServiceType = updateData.serviceType || bus.serviceType;
      if (route.serviceType && route.serviceType !== effectiveServiceType) {
        return res.status(400).json({
          success: false,
          message: 'Bus service type must match route service type'
        });
      }
    }

    const before = {
      busName: bus.busName,
      numberPlate: bus.numberPlate,
      registrationNumber: bus.registrationNumber,
      seatCapacity: bus.seatCapacity,
      busType: bus.busType,
      serviceType: bus.serviceType,
      bookingEnabled: bus.bookingEnabled,
      routeId: bus.routeId,
      isActive: bus.isActive,
      maintenanceStatus: bus.maintenanceStatus
    };

    Object.assign(bus, updateData);
    await bus.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'BUS_EDITED',
      entityType: 'BUS',
      entityId: bus.busId,
      metadata: { before, after: updateData }
    });

    return res.status(200).json({
      success: true,
      message: 'Bus updated successfully',
      data: bus
    });
  } catch (error) {
    next(error);
  }
};

exports.createBusAccountRequest = async (req, res, next) => {
  try {
    const {
      busId,
      busName,
      numberPlate,
      routeId,
      routeMode,
      seatCapacity,
      busType,
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
    // route for the bus at approval time instead of requiring a routeId here.
    const normalizedRouteMode = String(routeMode || 'EXISTING').toUpperCase();
    if (!['EXISTING', 'CUSTOM'].includes(normalizedRouteMode)) {
      return res.status(400).json({ success: false, message: 'routeMode must be EXISTING or CUSTOM' });
    }
    const isCustomRoute = normalizedRouteMode === 'CUSTOM';

    const normalizedBusId = String(busId || '').trim();
    const normalizedNumberPlate = String(numberPlate || '').trim().toUpperCase();
    const normalizedReg = String(req.body?.registrationNumber || `AUTO-${normalizedBusId}`).trim();
    const normalizedRouteId = String(routeId || '').trim();
    const normalizedEmail = String(driverEmail || '').trim().toLowerCase();

    if (!normalizedBusId || !normalizedNumberPlate || (!isCustomRoute && !normalizedRouteId) || !driverName || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: isCustomRoute
          ? 'busId, numberPlate, driverName, driverEmail, and password are required'
          : 'busId, numberPlate, routeId, driverName, driverEmail, and password are required'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const existingBus = await Bus.findOne({
      $or: [{ busId: normalizedBusId }, { registrationNumber: normalizedReg }, { numberPlate: normalizedNumberPlate }],
      isDeleted: false
    });
    if (existingBus) {
      return res.status(409).json({
        success: false,
        message: 'Bus ID, number plate, or registration number already exists'
      });
    }

    const existingDriverAccount = await User.findOne({ email: normalizedEmail });
    if (existingDriverAccount && existingDriverAccount.role !== 'driver') {
      return res.status(409).json({
        success: false,
        message: 'Email already exists on a non-driver account'
      });
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
        message: 'Bus service type must match route service type'
      });
    }

    const pendingForBus = await ManagerBusRequest.findOne({
      managerId: req.user._id,
      busId: normalizedBusId,
      status: 'PENDING',
      type: 'CREATE_BUS_ACCOUNT'
    });

    if (pendingForBus) {
      return res.status(409).json({
        success: false,
        message: 'A pending create request already exists for this bus ID'
      });
    }

    const requestDoc = await ManagerBusRequest.create({
      type: 'CREATE_BUS_ACCOUNT',
      managerId: req.user._id,
      busId: normalizedBusId,
      reason: String(reason || '').trim(),
      payload: {
        routeMode: normalizedRouteMode,
        bus: {
          busId: normalizedBusId,
          busName,
          numberPlate: normalizedNumberPlate,
          registrationNumber: normalizedReg,
          // routeId is left unset for CUSTOM; the super admin approval step
          // provisions a private route and fills this in before Bus.create.
          routeId: isCustomRoute ? undefined : normalizedRouteId,
          seatCapacity,
          busType: busType || 'AC',
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
      action: 'BUS_CREATE_REQUESTED',
      entityType: 'BUS_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: {
        busId: normalizedBusId,
        routeId: normalizedRouteId
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Bus creation request submitted for super admin approval',
      data: requestDoc
    });
  } catch (error) {
    next(error);
  }
};

exports.requestBusDelete = async (req, res, next) => {
  try {
    const bus = await getManagedBusByBusId(req.user._id, req.params.busId);
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found for this manager' });
    }

    const existingPendingDelete = await ManagerBusRequest.findOne({
      managerId: req.user._id,
      busId: bus.busId,
      type: 'DELETE_BUS',
      status: 'PENDING'
    });
    if (existingPendingDelete) {
      return res.status(409).json({ success: false, message: 'A pending delete request already exists for this bus' });
    }

    const requestDoc = await ManagerBusRequest.create({
      type: 'DELETE_BUS',
      managerId: req.user._id,
      busId: bus.busId,
      reason: String(req.body?.reason || '').trim(),
      payload: {
        busSnapshot: {
          busId: bus.busId,
          busName: bus.busName,
          registrationNumber: bus.registrationNumber,
          routeId: bus.routeId
        }
      }
    });

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'BUS_DELETE_REQUESTED',
      entityType: 'BUS_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: { busId: bus.busId }
    });

    return res.status(201).json({
      success: true,
      message: 'Bus deletion request submitted for super admin approval',
      data: requestDoc
    });
  } catch (error) {
    next(error);
  }
};

exports.getMyRequests = async (req, res, next) => {
  try {
    const requests = await ManagerBusRequest.find({ managerId: req.user._id })
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

exports.resetBusAccountPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const bus = await getManagedBusByBusId(req.user._id, req.params.busId);
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found for this manager' });
    }

    const driver = await User.findById(bus.driverId).select('+password');
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ success: false, message: 'Driver account not found for this bus' });
    }

    driver.password = password;
    driver.isEmailVerified = true;
    driver.isActive = true;
    await driver.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'BUS_ACCOUNT_PASSWORD_RESET',
      entityType: 'BUS_ACCOUNT',
      entityId: bus.busId,
      metadata: { driverId: driver._id }
    });

    return res.status(200).json({
      success: true,
      message: 'Bus account password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerBusLocation = async (req, res, next) => {
  try {
    const bus = await getManagedBusByBusId(req.user._id, req.params.busId);
    if (!bus) {
      return res.status(404).json({ success: false, message: 'Bus not found for this manager' });
    }

    const minutes = Number(req.query.minutes) || 15;
    const allowedMinutes = [15, 30, 60];
    const windowMinutes = allowedMinutes.includes(minutes) ? minutes : 15;
    const startTime = new Date(Date.now() - windowMinutes * 60 * 1000);

    const [latest, history] = await Promise.all([
      LiveLocation.findOne({ busId: bus.busId }).sort({ timestamp: -1 }).lean(),
      LiveLocation.find({ busId: bus.busId, timestamp: { $gte: startTime } })
        .sort({ timestamp: 1 })
        .lean()
    ]);

    return res.status(200).json({
      success: true,
      data: {
        bus: {
          busId: bus.busId,
          busName: bus.busName,
          routeId: bus.routeId
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

// @desc    Routes available for this manager to assign to a bus: public routes
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
