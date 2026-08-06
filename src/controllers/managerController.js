const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const ManagerVehicleRequest = require('../models/ManagerVehicleRequest');
const Route = require('../models/Route');
const Organization = require('../models/Organization');
const Driver = require('../models/Driver');
const { isEmailRegistered } = require('../utils/accountRegistry');
const { formatPlate, isValidPlate, PLATE_FORMAT_MESSAGE } = require('../utils/numberPlate');
const { isValidPhone, PHONE_FORMAT_MESSAGE } = require('../utils/phoneNumber');
const { generateUniqueDriverCode } = require('../utils/driverCode');
const { ensureDriverEnrollmentKey } = require('../utils/enrollmentKey');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
      const formatted = formatPlate(updateData.numberPlate);
      if (!formatted) {
        return res.status(400).json({ success: false, message: PLATE_FORMAT_MESSAGE });
      }
      // Stored canonical, so the same plate typed any which way is one record.
      updateData.numberPlate = formatted;
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
        isDeleted: false
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

// A manager creates vehicles in their own fleet outright. This used to raise a
// request for a super admin to approve, which left a new manager unable to add
// anything at all until somebody else acted.
exports.createManagerVehicle = async (req, res, next) => {
  try {
    const {
      vehicleId,
      vehicleName,
      numberPlate,
      routeId,
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

    const normalizedVehicleId = String(vehicleId || '').trim();
    // Canonical, so "PF- 2327" and "pf2327" are the same plate on the way in.
    const normalizedNumberPlate = formatPlate(numberPlate) || String(numberPlate || '').trim().toUpperCase();
    const normalizedReg = String(req.body?.registrationNumber || `AUTO-${normalizedVehicleId}`).trim();
    const normalizedRouteId = String(routeId || '').trim();
    const normalizedEmail = String(driverEmail || '').trim().toLowerCase();

    // The driver's email is optional here for the same reason it is on the
    // drivers page: they sign in with a driver code.
    if (!normalizedVehicleId || !normalizedNumberPlate || !normalizedRouteId || !driverName || !password) {
      return res.status(400).json({
        success: false,
        message: 'vehicleId, numberPlate, routeId, driverName, and password are required'
      });
    }

    if (normalizedEmail && !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    if (!isValidPlate(normalizedNumberPlate)) {
      return res.status(400).json({ success: false, message: PLATE_FORMAT_MESSAGE });
    }

    const normalizedDriverPhone = String(driverPhoneNumber || '').trim();
    if (normalizedDriverPhone && !isValidPhone(normalizedDriverPhone)) {
      return res.status(400).json({ success: false, message: PHONE_FORMAT_MESSAGE });
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

    // An email already on a driver may only be reused when that driver belongs
    // to this manager. Reusing anybody else's would hand their account over,
    // since the request carries a new password.
    let driver = null;
    let reusedExistingDriver = false;
    if (normalizedEmail) {
      const existingDriverAccount = await Driver.findOne({ email: normalizedEmail });
      if (existingDriverAccount) {
        if (String(existingDriverAccount.managerId || '') !== String(req.user._id)) {
          return res.status(409).json({
            success: false,
            message: 'A driver with this email already exists'
          });
        }
        driver = existingDriverAccount;
        reusedExistingDriver = true;
      } else if (await isEmailRegistered(normalizedEmail)) {
        return res.status(409).json({
          success: false,
          message: 'Email already exists on a non-driver account'
        });
      }
    }

    const route = await Route.findOne({ routeId: normalizedRouteId, isDeleted: false });
    if (!route) {
      return res.status(400).json({ success: false, message: 'Invalid route ID' });
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

    // A manager owns their own fleet, so the vehicle and its driver are created
    // here rather than queued for a super admin to approve.
    const driverFields = {
      name: String(driverName).trim(),
      phoneNumber: normalizedDriverPhone,
      nicNumber: String(driverNicNumber || '').trim(),
      licenseCardNumber: String(driverLicenseCardNumber || '').trim(),
      password,
      isActive: true,
      isEmailVerified: true,
      managerId: req.user._id
    };

    if (driver) {
      Object.assign(driver, driverFields);
      if (!driver.driverCode) driver.driverCode = await generateUniqueDriverCode(Driver);
      await driver.save();
    } else {
      driver = await Driver.create({
        ...driverFields,
        // Left off entirely rather than stored blank, so the sparse unique index
        // does not treat two email-less drivers as duplicates.
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        driverCode: await generateUniqueDriverCode(Driver)
      });
    }

    let vehicle;
    try {
      vehicle = await Vehicle.create({
        vehicleId: normalizedVehicleId,
        vehicleName,
        numberPlate: normalizedNumberPlate,
        registrationNumber: normalizedReg,
        routeId: normalizedRouteId,
        seatCapacity,
        vehicleType: vehicleType || 'AC',
        serviceType: normalizedServiceType,
        bookingEnabled: bookingEnabled !== undefined ? Boolean(bookingEnabled) : true,
        managerId: req.user._id,
        driverId: driver._id,
        isActive: true,
        isDeleted: false
      });
    } catch (error) {
      // A driver with no vehicle is a half-provisioned account nobody asked
      // for, so a brand new one goes back if the vehicle will not save.
      if (!reusedExistingDriver) await Driver.deleteOne({ _id: driver._id });
      throw error;
    }

    const enrollmentKey = await ensureDriverEnrollmentKey(driver._id);

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'VEHICLE_CREATED',
      entityType: 'VEHICLE',
      entityId: vehicle.vehicleId,
      metadata: {
        vehicleId: normalizedVehicleId,
        routeId: normalizedRouteId,
        driverId: String(driver._id),
        reason: String(reason || '').trim()
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Vehicle created',
      data: {
        vehicle,
        driver: {
          _id: driver._id,
          name: driver.name,
          email: driver.email || '',
          driverCode: driver.driverCode || null
        }
      },
      enrollmentKey
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

// @desc    Routes available for this manager to assign to a vehicle: public routes
//          plus this manager's own named (ACTIVE) private custom routes.
// @route   GET /api/manager/routes
exports.getManagerAssignableRoutes = async (req, res, next) => {
  try {
    const routes = await Route.find({
      isDeleted: false,
      isActive: true
    }).select('routeId routeName source destination fare estimatedTime serviceType distance stopsCount stops');

    return res.status(200).json({ success: true, count: routes.length, data: routes });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle QR attendance for one of this manager's own routes.
// @route   PATCH /api/manager/routes/:routeId/qr
// Moved here when private routes were removed — QR attendance is independent of
// route privacy and works on public routes, which is what most riders use.
exports.updateRouteQr = async (req, res, next) => {
  try {
    const route = await Route.findOne({
      routeId: String(req.params.routeId).toUpperCase(),
      managerId: req.user._id,
      isDeleted: false
    });
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    route.qrEnabled = !!(req.body || {}).qrEnabled;
    await route.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROUTE_QR_UPDATED',
      entityType: 'ROUTE',
      entityId: route.routeId,
      metadata: { qrEnabled: route.qrEnabled }
    });

    return res.status(200).json({
      success: true,
      message: 'Route QR attendance updated',
      data: { routeId: route.routeId, qrEnabled: route.qrEnabled }
    });
  } catch (error) {
    next(error);
  }
};
