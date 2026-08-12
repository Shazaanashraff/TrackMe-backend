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
const { plateConflict } = require('../utils/vehiclePlateGuard');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VEHICLE_TYPES = ['AC', 'NON-AC', 'DELUXE', 'SLEEPER'];

const MANAGER_EDITABLE_FIELDS = [
  'vehicleName',
  'numberPlate',
  'registrationNumber',
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
      .populate('driverId', 'name email driverCode')
      .populate('organization', 'name serviceType')
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
  // Declared outside the try so the catch block can use them to rebuild the
  // same friendly conflict message the pre-check path returns, when a
  // concurrent request wins the race between that check and this save().
  let vehicle;
  let updateData;
  try {
    vehicle = await getManagedVehicleByVehicleId(req.user._id, req.params.vehicleId);

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

    updateData = {};
    for (const key of MANAGER_EDITABLE_FIELDS) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ success: false, message: 'No editable fields provided' });
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

      const conflict = await plateConflict(formatted, {
        managerId: req.user._id,
        excludeId: vehicle._id
      });
      if (conflict) {
        return res.status(conflict.status).json({ success: false, message: conflict.message });
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
    // The findOne-then-save above isn't atomic — a concurrent request can pass
    // plateConflict's check before either save() lands, so the unique index is
    // the real guard and can still throw here. Turn that into the same friendly
    // 409 the pre-check path returns, instead of a raw duplicate-key 500/400.
    if (error.code === 11000 && updateData?.numberPlate) {
      const conflict = await plateConflict(updateData.numberPlate, {
        managerId: req.user._id,
        excludeId: vehicle?._id
      });
      if (conflict) {
        return res.status(conflict.status).json({ success: false, message: conflict.message });
      }
    }
    next(error);
  }
};

// A vehicle carries the same organization as the drivers who drive it. The id
// is enough on its own; the category is only used to catch a mismatch, since
// the form offers both.
async function resolveVehicleOrganization(body) {
  const { organizationId, organizationCategory } = body || {};
  if (!organizationId) return { organizationId: null, serviceType: null };

  const organization = await Organization.findOne({
    _id: organizationId,
    isDeleted: false
  }).lean();
  if (!organization) {
    return { error: { status: 400, message: 'Organization not found' } };
  }

  if (organizationCategory
    && String(organizationCategory).toUpperCase() !== organization.serviceType) {
    return {
      error: { status: 400, message: 'Organization does not match the selected category' }
    };
  }

  return { organizationId: organization._id, serviceType: organization.serviceType };
}

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

    // A vehicle may be added to the fleet on its own and given a driver later,
    // so the driver half of this form is optional. Naming a driver still means
    // giving them a password.
    const wantsDriver = Boolean(String(driverName || '').trim());

    if (!normalizedVehicleId || !normalizedNumberPlate) {
      return res.status(400).json({
        success: false,
        message: 'vehicleId and numberPlate are required'
      });
    }

    if (wantsDriver && !password) {
      return res.status(400).json({
        success: false,
        message: 'A driver needs a password'
      });
    }

    if (normalizedEmail && !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }

    if (password && String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    if (!isValidPlate(normalizedNumberPlate)) {
      return res.status(400).json({ success: false, message: PLATE_FORMAT_MESSAGE });
    }

    const normalizedDriverPhone = String(driverPhoneNumber || '').trim();
    if (normalizedDriverPhone && !isValidPhone(normalizedDriverPhone)) {
      return res.status(400).json({ success: false, message: PHONE_FORMAT_MESSAGE });
    }

    // The plate is checked on its own so the manager is told which vehicle
    // holds it, rather than being handed a list of three things it might be.
    const conflict = await plateConflict(normalizedNumberPlate, { managerId: req.user._id });
    if (conflict) {
      return res.status(conflict.status).json({ success: false, message: conflict.message });
    }

    const existingVehicle = await Vehicle.findOne({
      $or: [{ vehicleId: normalizedVehicleId }, { registrationNumber: normalizedReg }],
      isDeleted: false
    });
    if (existingVehicle) {
      return res.status(409).json({
        success: false,
        message: 'Vehicle ID or registration number already exists'
      });
    }

    // An email already on a driver may only be reused when that driver belongs
    // to this manager. Reusing anybody else's would hand their account over,
    // since the request carries a new password.
    let driver = null;
    let reusedExistingDriver = false;
    if (wantsDriver && normalizedEmail) {
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
          message: 'That email belongs to a super-admin account and cannot be used for a bus account'
        });
      }
    }

    // A route can be attached later, so it is only checked when one is given.
    let route = null;
    if (normalizedRouteId) {
      route = await Route.findOne({ routeId: normalizedRouteId, isDeleted: false });
      if (!route) {
        return res.status(400).json({ success: false, message: 'Invalid route ID' });
      }
    }

    const org = await resolveVehicleOrganization(req.body);
    if (org.error) {
      return res.status(org.error.status).json({ success: false, message: org.error.message });
    }

    const normalizedServiceType = String(
      serviceType || org.serviceType || route?.serviceType || 'PUBLIC'
    ).toUpperCase();
    if (!SERVICE_TYPES.includes(normalizedServiceType)) {
      return res.status(400).json({ success: false, message: 'Invalid service type' });
    }

    if (route?.serviceType && route.serviceType !== normalizedServiceType) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle service type must match route service type'
      });
    }

    // A manager owns their own fleet, so the vehicle is created here rather than
    // queued for a super admin to approve. Its driver, if one was named, comes
    // with it.
    if (wantsDriver) {
      const driverFields = {
        name: String(driverName).trim(),
        phoneNumber: normalizedDriverPhone,
        nicNumber: String(driverNicNumber || '').trim(),
        licenseCardNumber: String(driverLicenseCardNumber || '').trim(),
        password,
        isActive: true,
        isEmailVerified: true,
        managerId: req.user._id,
        organization: org.organizationId
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
    }

    let vehicle;
    try {
      vehicle = await Vehicle.create({
        vehicleId: normalizedVehicleId,
        // Named after its plate unless the manager gave it a name.
        vehicleName: String(vehicleName || '').trim() || normalizedNumberPlate,
        numberPlate: normalizedNumberPlate,
        registrationNumber: normalizedReg,
        routeId: normalizedRouteId,
        vehicleType: vehicleType || 'AC',
        serviceType: normalizedServiceType,
        organization: org.organizationId,
        bookingEnabled: bookingEnabled !== undefined ? Boolean(bookingEnabled) : true,
        managerId: req.user._id,
        driverId: driver ? driver._id : null,
        isActive: true,
        isDeleted: false
      });
    } catch (error) {
      // A driver with no vehicle is a half-provisioned account nobody asked
      // for, so a brand new one goes back if the vehicle will not save.
      if (driver && !reusedExistingDriver) await Driver.deleteOne({ _id: driver._id });
      throw error;
    }

    const enrollmentKey = driver ? await ensureDriverEnrollmentKey(driver._id) : null;

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
        driverId: driver ? String(driver._id) : null,
        reason: String(reason || '').trim()
      }
    });

    return res.status(201).json({
      success: true,
      message: driver ? 'Vehicle created' : 'Vehicle created. Add a driver to put it on the road.',
      data: {
        vehicle,
        driver: driver
          ? {
            _id: driver._id,
            name: driver.name,
            email: driver.email || '',
            driverCode: driver.driverCode || null
          }
          : null
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

    // Drivers sign in with a driver code + password stored directly on their own
    // account, not through the shared Identity login, so a manager may reset it
    // outright — there's no other app session that a rewrite could hijack.
    driver.password = password;
    // A password reset genuinely implies the account is now reachable, so
    // verifying it is a real side effect of this action. Reactivating it is
    // not: isActive was set false by a deliberate choice (a manager's own
    // driver-deactivation, or in the future a super-admin's), and this
    // endpoint has nothing to do with that decision — never override it.
    driver.isEmailVerified = true;
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
