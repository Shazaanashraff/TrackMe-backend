const Bus = require('../models/Bus');
const Booking = require('../models/Booking');
const LiveLocation = require('../models/LiveLocation');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const ManagerBusRequest = require('../models/ManagerBusRequest');
const Route = require('../models/Route');
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
      const route = await Route.findOne({ routeId: updateData.routeId, isDeleted: false });
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

    const normalizedBusId = String(busId || '').trim();
    const normalizedNumberPlate = String(numberPlate || '').trim().toUpperCase();
    const normalizedReg = String(req.body?.registrationNumber || `AUTO-${normalizedBusId}`).trim();
    const normalizedRouteId = String(routeId || '').trim();
    const normalizedEmail = String(driverEmail || '').trim().toLowerCase();

    if (!normalizedBusId || !normalizedNumberPlate || !normalizedRouteId || !driverName || !normalizedEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'busId, numberPlate, routeId, driverName, driverEmail, and password are required'
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

    const route = await Route.findOne({ routeId: normalizedRouteId, isDeleted: false });
    if (!route) {
      return res.status(400).json({ success: false, message: 'Invalid route ID' });
    }

    const normalizedServiceType = String(serviceType || route.serviceType || 'PUBLIC').toUpperCase();
    if (!SERVICE_TYPES.includes(normalizedServiceType)) {
      return res.status(400).json({ success: false, message: 'Invalid service type' });
    }

    if (route.serviceType && route.serviceType !== normalizedServiceType) {
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
        bus: {
          busId: normalizedBusId,
          busName,
          numberPlate: normalizedNumberPlate,
          registrationNumber: normalizedReg,
          routeId: normalizedRouteId,
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
