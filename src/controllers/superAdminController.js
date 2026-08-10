const Manager = require('../models/Manager');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const VehicleReview = require('../models/VehicleReview');
const Route = require('../models/Route');
const Organization = require('../models/Organization');
const ManagerVehicleRequest = require('../models/ManagerVehicleRequest');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const Identity = require('../models/Identity');
const {
  findIdentityByEmail,
  findProfilesForIdentity,
  attachProfile,
  createIdentityWithProfile,
  isEmailRegistered,
  SuperAdminIsolationError
} = require('../utils/identityRegistry');
const { adminSetOrMailReset } = require('../utils/passwordReset');
const { allRequestedIdsFound } = require('../utils/idValidation');
const {
  listOrganizations,
  createOrganization: createOrganizationRecord,
  publicOrganization
} = require('../utils/organizations');

const MANAGER_SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];

// Roster status the super admin sees. INACTIVE (deactivated) takes precedence;
// otherwise a manager who was invited but hasn't set a password yet is INVITED,
// and everyone else (incl. pre-invite/seeded managers) is ACTIVE.
const managerStatus = (manager) => {
  if (manager.isActive === false) return 'INACTIVE';
  if (manager.invitedAt && !manager.activatedAt) return 'INVITED';
  return 'ACTIVE';
};

const sanitizeManager = (manager) => ({
  _id: manager._id,
  name: manager.name,
  email: manager.email,
  role: 'admin',
  isActive: manager.isActive !== false,
  status: managerStatus(manager),
  invitedAt: manager.invitedAt || null,
  activatedAt: manager.activatedAt || null,
  province: manager.province || '',
  serviceType: manager.serviceType || 'PUBLIC',
  // organization may be a populated doc, a raw ObjectId, or null.
  organization:
    manager.organization && manager.organization._id
      ? { _id: manager.organization._id, name: manager.organization.name }
      : null,
  createdAt: manager.createdAt,
  updatedAt: manager.updatedAt
});

// Validates a manager's service/organization pairing. Returns { organization }
// (the resolved Organization doc or null) on success, or { error } with an HTTP
// status + message. PUBLIC managers must have no organization; the private service
// types must reference an existing organization of the matching service type.
const resolveManagerService = async (serviceType, organizationId) => {
  if (!MANAGER_SERVICE_TYPES.includes(serviceType)) {
    return { error: { status: 400, message: 'Invalid service type' } };
  }

  if (serviceType === 'PUBLIC') {
    return { organization: null };
  }

  if (!organizationId) {
    return { error: { status: 400, message: 'An organization is required for this service type' } };
  }

  const organization = await Organization.findOne({ _id: organizationId, isDeleted: false });
  if (!organization) {
    return { error: { status: 404, message: 'Organization not found' } };
  }
  if (organization.serviceType !== serviceType) {
    return { error: { status: 400, message: 'Organization does not match the selected service type' } };
  }
  return { organization };
};

exports.createManager = async (req, res, next) => {
  try {
    const { name, email, password, serviceType = 'PUBLIC', organizationId = null } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const resolved = await resolveManagerService(serviceType, organizationId);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    const resolvedOrganizationId = resolved.organization ? resolved.organization._id : null;

    const existingIdentity = await findIdentityByEmail(normalizedEmail);

    // A brand-new person: create their login and their manager profile together. The
    // login starts provisional, so the super-admin's chosen password is allowed to
    // stand until the manager first signs in.
    if (!existingIdentity) {
      const { doc: manager } = await createIdentityWithProfile({
        email: normalizedEmail,
        password,
        isEmailVerified: true,
        isProvisional: true,
        role: 'admin',
        fields: {
          name: name.trim(),
          isActive: true,
          isEmailVerified: true,
          serviceType,
          organization: resolvedOrganizationId,
          activatedAt: new Date()
        }
      });
      await manager.populate('organization', 'name serviceType');

      return res.status(201).json({
        success: true,
        message: 'Manager created successfully',
        data: sanitizeManager(manager)
      });
    }

    const profiles = await findProfilesForIdentity(existingIdentity._id);

    if (profiles.some((p) => p.role === 'admin')) {
      return res.status(409).json({
        success: false,
        message: 'This email is already registered to a different account type.'
      });
    }

    // This email already belongs to somebody on TrackMe (typically a rider). Give
    // that existing person the manager role rather than refusing the email — but
    // deliberately IGNORE the password typed into the form: it is not the
    // super-admin's to set. They keep signing in with the password they already have.
    const { doc: manager } = await attachProfile({
      identityId: existingIdentity._id,
      role: 'admin',
      fields: {
        name: name.trim(),
        isActive: true,
        isEmailVerified: true,
        serviceType,
        organization: resolvedOrganizationId,
        activatedAt: new Date()
      }
    });

    await manager.populate('organization', 'name serviceType');

    return res.status(201).json({
      success: true,
      message: 'Manager role added to the existing TrackMe account for this email',
      attachedToExistingIdentity: true,
      existingRoles: profiles.map((p) => p.role),
      // Nothing to hand over: they sign in with their own password. If the account is
      // Google-only it has no password at all and they must use Google or set one.
      passwordSetupRequired: !existingIdentity.password && !existingIdentity.googleId,
      data: sanitizeManager(manager)
    });
  } catch (error) {
    if (error instanceof SuperAdminIsolationError) {
      return res.status(409).json({ success: false, code: error.code, message: error.message });
    }
    next(error);
  }
};

exports.getManagers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (pageNumber - 1) * limitNumber;

    const filter = search
      ? {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
          ]
        }
      : {};

    const [managers, total] = await Promise.all([
      Manager.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .populate('organization', 'name serviceType')
        .lean(),
      Manager.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      data: managers.map(sanitizeManager),
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        pages: Math.ceil(total / limitNumber)
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerById = async (req, res, next) => {
  try {
    const manager = await Manager.findById(req.params.managerId)
      .populate('organization', 'name serviceType')
      .lean();
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const [fleetCounts, bookingKpis, reviewKpis] = await Promise.all([
      Vehicle.aggregate([
        { $match: { managerId: manager._id, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalVehicles: { $sum: 1 },
            activeVehicles: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveVehicles: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } }
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
            'vehicleInfo.managerId': manager._id
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
      VehicleReview.aggregate([
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
            'vehicleInfo.managerId': manager._id
          }
        },
        {
          $group: {
            _id: null,
            reviewCount: { $sum: 1 },
            averageRating: { $avg: '$rating' }
          }
        }
      ])
    ]);

    return res.status(200).json({
      success: true,
      data: {
        manager: sanitizeManager(manager),
        fleet: fleetCounts[0] || { totalVehicles: 0, activeVehicles: 0, inactiveVehicles: 0 },
        bookingKpis: bookingKpis[0] || { totalBookings: 0, confirmedBookings: 0, cancelledBookings: 0, totalRevenue: 0 },
        reviewKpis: {
          reviewCount: reviewKpis[0]?.reviewCount || 0,
          averageRating: Number((reviewKpis[0]?.averageRating || 0).toFixed(2))
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.updateManager = async (req, res, next) => {
  try {
    const { name, email, serviceType, organizationId } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const nextEmail = email ? email.toLowerCase().trim() : null;

    if (nextEmail && nextEmail !== manager.email) {
      // Changing the email now renames the person's whole login, not just this
      // manager record — so it is only safe when the manager role is all they have.
      const profiles = await findProfilesForIdentity(manager.identityId);
      if (profiles.length > 1) {
        return res.status(409).json({
          success: false,
          code: 'IDENTITY_SHARED_EMAIL_IMMUTABLE',
          message:
            'This email is shared with other TrackMe roles for the same person. They must change it themselves.'
        });
      }

      const duplicate = await isEmailRegistered(nextEmail, { excludeIdentityId: manager.identityId });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'Email already in use by another account' });
      }

      // Update the login, then re-mirror onto the profile so the two cannot drift.
      const identity = await Identity.findById(manager.identityId);
      if (identity) {
        identity.email = nextEmail;
        await identity.save();
      }
      manager.email = nextEmail;
    }

    // Re-resolve service/organization when the service type is being changed.
    if (serviceType !== undefined) {
      const resolved = await resolveManagerService(
        serviceType,
        organizationId !== undefined ? organizationId : (manager.organization || null)
      );
      if (resolved.error) {
        return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
      }
      manager.serviceType = serviceType;
      manager.organization = resolved.organization ? resolved.organization._id : null;
    }

    if (name) manager.name = name.trim();

    await manager.save();
    await manager.populate('organization', 'name serviceType');

    return res.status(200).json({
      success: true,
      message: 'Manager updated successfully',
      data: sanitizeManager(manager)
    });
  } catch (error) {
    next(error);
  }
};

exports.updateManagerStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    manager.isActive = Boolean(isActive);
    await manager.save();

    return res.status(200).json({
      success: true,
      message: `Manager ${manager.isActive ? 'activated' : 'deactivated'} successfully`,
      data: sanitizeManager(manager)
    });
  } catch (error) {
    next(error);
  }
};

// Hard-deletes a manager account. Gated on the manager already being
// deactivated so the super admin always takes the reversible step (deactivate)
// before the irreversible one. Vehicles the manager owned are unassigned rather
// than deleted — they return to the pool for another manager to pick up.
exports.deleteManager = async (req, res, next) => {
  try {
    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    if (manager.isActive !== false) {
      return res.status(409).json({
        success: false,
        message: 'Deactivate this manager before deleting the account'
      });
    }

    const { modifiedCount } = await Vehicle.updateMany(
      { managerId: manager._id },
      { $set: { managerId: null } }
    );

    await manager.deleteOne();

    return res.status(200).json({
      success: true,
      message: 'Manager deleted successfully',
      data: { _id: manager._id, unassignedVehicles: modifiedCount }
    });
  } catch (error) {
    next(error);
  }
};

// Super-admin-triggered password reset. The super admin sets the new password
// directly and hands it to the manager out of band — no emailed link.
exports.resetManagerPassword = async (req, res, next) => {
  try {
    const { password } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const identity = await Identity.findById(manager.identityId).select('+password');
    if (!identity) {
      return res.status(404).json({ success: false, message: 'Login not found for this manager' });
    }

    // A password may only be written while the login is still provisional (created by
    // an admin and never used). Afterwards it is that person's own credential — and it
    // may also unlock their rider account — so we mail them a reset code instead.
    const { written, emailSent, otp } = await adminSetOrMailReset(identity, password);

    const response = {
      success: true,
      passwordWritten: written,
      passwordResetEmailSent: !written,
      message: written
        ? 'Manager password reset successfully'
        : 'This manager has already signed in, so their password cannot be overwritten. A reset code has been emailed to them.'
    };

    if (!written && !emailSent && process.env.NODE_ENV !== 'production') {
      response.developmentOtp = otp;
    }

    return res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

exports.assignVehiclesToManager = async (req, res, next) => {
  try {
    const { vehicleIds } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const vehicles = await Vehicle.find({ _id: { $in: vehicleIds }, isDeleted: false });
    if (!allRequestedIdsFound(vehicleIds, vehicles)) {
      return res.status(400).json({
        success: false,
        message: 'One or more vehicle IDs are invalid'
      });
    }

    await Vehicle.updateMany(
      { _id: { $in: vehicleIds } },
      { $set: { managerId: manager._id } }
    );

    return res.status(200).json({
      success: true,
      message: 'Vehicles assigned to manager successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.getSuperAdminDashboard = async (req, res, next) => {
  try {
    const [managerCounts, vehicleCounts, bookingSummary, reviewSummary] = await Promise.all([
      Manager.aggregate([
        {
          $group: {
            _id: null,
            totalManagers: { $sum: 1 },
            activeManagers: { $sum: { $cond: [{ $ne: ['$isActive', false] }, 1, 0] } },
            inactiveManagers: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } }
          }
        }
      ]),
      Vehicle.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            totalVehicles: { $sum: 1 },
            activeVehicles: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveVehicles: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
            maintenanceVehicles: {
              $sum: { $cond: [{ $eq: ['$maintenanceStatus', 'MAINTENANCE'] }, 1, 0] }
            }
          }
        }
      ]),
      Booking.aggregate([
        { $match: { isDeleted: false } },
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
      VehicleReview.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            totalReviews: { $sum: 1 },
            averageRating: { $avg: '$rating' }
          }
        }
      ])
    ]);

    return res.status(200).json({
      success: true,
      data: {
        managers: managerCounts[0] || { totalManagers: 0, activeManagers: 0, inactiveManagers: 0 },
        vehicles: vehicleCounts[0] || { totalVehicles: 0, activeVehicles: 0, inactiveVehicles: 0, maintenanceVehicles: 0 },
        bookings: bookingSummary[0] || { totalBookings: 0, confirmedBookings: 0, cancelledBookings: 0, totalRevenue: 0 },
        reviews: {
          totalReviews: reviewSummary[0]?.totalReviews || 0,
          averageRating: Number((reviewSummary[0]?.averageRating || 0).toFixed(2))
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getOperationsOverview = async (req, res, next) => {
  try {
    const managers = await Manager.find()
      .select('name email isActive createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const managerIds = managers.map((manager) => manager._id);

    const [fleetByManager, bookingsByManager, reviewsByManager] = await Promise.all([
      Vehicle.aggregate([
        { $match: { isDeleted: false, managerId: { $in: managerIds } } },
        {
          $group: {
            _id: '$managerId',
            totalVehicles: { $sum: 1 },
            activeVehicles: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveVehicles: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } }
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
            'vehicleInfo.managerId': { $in: managerIds }
          }
        },
        {
          $group: {
            _id: '$vehicleInfo.managerId',
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
      VehicleReview.aggregate([
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
            'vehicleInfo.managerId': { $in: managerIds }
          }
        },
        {
          $group: {
            _id: '$vehicleInfo.managerId',
            averageRating: { $avg: '$rating' },
            reviewCount: { $sum: 1 }
          }
        }
      ])
    ]);

    const fleetMap = new Map(fleetByManager.map((item) => [String(item._id), item]));
    const bookingMap = new Map(bookingsByManager.map((item) => [String(item._id), item]));
    const reviewMap = new Map(reviewsByManager.map((item) => [String(item._id), item]));

    const data = managers.map((manager) => {
      const fleet = fleetMap.get(String(manager._id)) || {
        totalVehicles: 0,
        activeVehicles: 0,
        inactiveVehicles: 0
      };
      const booking = bookingMap.get(String(manager._id)) || {
        totalBookings: 0,
        confirmedBookings: 0,
        cancelledBookings: 0,
        totalRevenue: 0
      };
      const review = reviewMap.get(String(manager._id)) || {
        averageRating: 0,
        reviewCount: 0
      };

      return {
        managerId: manager._id,
        managerName: manager.name,
        managerEmail: manager.email,
        isActive: manager.isActive !== false,
        createdAt: manager.createdAt,
        fleet,
        bookings: booking,
        reviews: {
          averageRating: Number((review.averageRating || 0).toFixed(2)),
          reviewCount: review.reviewCount || 0
        }
      };
    });

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

exports.getManagerVehicleDetails = async (req, res, next) => {
  try {
    const manager = await Manager.findById(req.params.managerId)
      .select('name email isActive createdAt')
      .lean();

    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const vehicles = await Vehicle.find({ managerId: manager._id, isDeleted: false })
      .populate('driverId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    const vehicleIds = vehicles.map((vehicle) => vehicle._id);

    const [bookingByVehicle, reviewByVehicle] = await Promise.all([
      Booking.aggregate([
        { $match: { isDeleted: false, vehicleId: { $in: vehicleIds } } },
        {
          $group: {
            _id: '$vehicleId',
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
      VehicleReview.aggregate([
        { $match: { isDeleted: false, vehicleId: { $in: vehicleIds } } },
        {
          $group: {
            _id: '$vehicleId',
            averageRating: { $avg: '$rating' },
            reviewCount: { $sum: 1 }
          }
        }
      ])
    ]);

    const bookingMap = new Map(bookingByVehicle.map((item) => [String(item._id), item]));
    const reviewMap = new Map(reviewByVehicle.map((item) => [String(item._id), item]));

    const vehicleDetails = vehicles.map((vehicle) => {
      const booking = bookingMap.get(String(vehicle._id)) || {
        totalBookings: 0,
        confirmedBookings: 0,
        cancelledBookings: 0,
        totalRevenue: 0
      };
      const review = reviewMap.get(String(vehicle._id)) || {
        averageRating: 0,
        reviewCount: 0
      };

      return {
        ...vehicle,
        bookingMetrics: booking,
        reviewMetrics: {
          averageRating: Number((review.averageRating || 0).toFixed(2)),
          reviewCount: review.reviewCount || 0
        }
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        manager,
        vehicles: vehicleDetails
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getPendingVehicleRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const type = String(req.query.type || 'ALL').toUpperCase();
    const managerId = req.query.managerId ? String(req.query.managerId) : '';
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'];
    const validTypes = ['CREATE_VEHICLE_ACCOUNT', 'DELETE_VEHICLE', 'ALL'];
    const effectiveStatus = validStatuses.includes(status) ? status : 'PENDING';
    const effectiveType = validTypes.includes(type) ? type : 'ALL';

    const filter = {};
    if (effectiveStatus !== 'ALL') {
      filter.status = effectiveStatus;
    }
    if (effectiveType !== 'ALL') {
      filter.type = effectiveType;
    }
    if (managerId) {
      filter.managerId = managerId;
    }

    const requests = await ManagerVehicleRequest.find(filter)
      .populate('managerId', 'name email')
      .populate('decisionBy', 'name email')
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

exports.reviewVehicleRequest = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { decision, note } = req.body;

    const normalizedDecision = String(decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(normalizedDecision)) {
      return res.status(400).json({ success: false, message: 'decision must be APPROVE or REJECT' });
    }

    const requestDoc = await ManagerVehicleRequest.findById(requestId);
    if (!requestDoc) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (requestDoc.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: 'Request already reviewed' });
    }

    if (normalizedDecision === 'REJECT') {
      requestDoc.status = 'REJECTED';
      requestDoc.decisionBy = req.user._id;
      requestDoc.decisionNote = String(note || '').trim();
      requestDoc.decidedAt = new Date();
      await requestDoc.save();

      await ManagerAuditLog.create({
        managerId: requestDoc.managerId,
        actorId: req.user._id,
        actorRole: 'super-admin',
        action: 'VEHICLE_REQUEST_REJECTED',
        entityType: 'VEHICLE_REQUEST',
        entityId: requestDoc._id.toString(),
        metadata: {
          type: requestDoc.type,
          vehicleId: requestDoc.vehicleId,
          note: requestDoc.decisionNote
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Request rejected',
        data: requestDoc
      });
    }

    if (requestDoc.type === 'CREATE_VEHICLE_ACCOUNT') {
      const vehiclePayload = requestDoc.payload?.vehicle || {};
      const driverPayload = requestDoc.payload?.driver || {};
      if (!vehiclePayload.numberPlate && vehiclePayload.registrationNumber) {
        vehiclePayload.numberPlate = String(vehiclePayload.registrationNumber).toUpperCase();
      }
      if (!vehiclePayload.registrationNumber && vehiclePayload.vehicleId) {
        vehiclePayload.registrationNumber = `AUTO-${vehiclePayload.vehicleId}`;
      }

      const route = await Route.findOne({ routeId: vehiclePayload.routeId, isDeleted: false });
      if (!route) {
        return res.status(400).json({ success: false, message: 'Cannot approve request: route no longer exists' });
      }

      const duplicateVehicle = await Vehicle.findOne({
        $or: [
          { vehicleId: vehiclePayload.vehicleId },
          { registrationNumber: vehiclePayload.registrationNumber },
          { numberPlate: vehiclePayload.numberPlate }
        ],
        isDeleted: false
      });
      if (duplicateVehicle) {
        return res.status(409).json({ success: false, message: 'Cannot approve request: vehicle already exists' });
      }

      const driverEmail = String(driverPayload.email || '').toLowerCase();
      const driverFields = {
        name: driverPayload.name,
        phoneNumber: String(driverPayload.phoneNumber || '').trim(),
        nicNumber: String(driverPayload.nicNumber || '').trim(),
        licenseCardNumber: String(driverPayload.licenseCardNumber || '').trim(),
        isActive: true,
        isEmailVerified: true
      };

      const existingIdentity = await findIdentityByEmail(driverEmail);
      let driver;

      if (!existingIdentity) {
        // Nobody owns this email yet — create the login provisionally so the password
        // the manager supplied stands until the driver first signs in.
        ({ doc: driver } = await createIdentityWithProfile({
          email: driverEmail,
          password: driverPayload.password,
          isEmailVerified: true,
          isProvisional: true,
          role: 'driver',
          fields: driverFields
        }));
      } else {
        try {
          // This email already has a TrackMe login (often the person's own rider
          // account). Attach the driver role to it. Crucially we do NOT touch the
          // password: overwriting it here would let any manager take over the rider
          // account behind any email they type into the bus-request form.
          const attached = await attachProfile({
            identityId: existingIdentity._id,
            role: 'driver',
            fields: driverFields
          });
          driver = attached.doc;

          // Reusing an existing driver profile: refresh the details the manager sent,
          // re-enable it, but never the credentials.
          if (!attached.created) {
            driver.isActive = true;
            if (driverPayload.phoneNumber) driver.phoneNumber = String(driverPayload.phoneNumber).trim();
            if (driverPayload.nicNumber) driver.nicNumber = String(driverPayload.nicNumber).trim();
            if (driverPayload.licenseCardNumber) driver.licenseCardNumber = String(driverPayload.licenseCardNumber).trim();
            await driver.save();
          }
        } catch (attachError) {
          if (attachError instanceof SuperAdminIsolationError) {
            return res.status(409).json({
              success: false,
              code: attachError.code,
              message: 'Cannot approve request: that email belongs to a super-admin account'
            });
          }
          throw attachError;
        }
      }

      await Vehicle.create({
        ...vehiclePayload,
        managerId: requestDoc.managerId,
        driverId: driver._id,
        isActive: true,
        isDeleted: false
      });
    }

    if (requestDoc.type === 'DELETE_VEHICLE') {
      const vehicle = await Vehicle.findOne({ vehicleId: requestDoc.vehicleId, managerId: requestDoc.managerId, isDeleted: false });
      if (!vehicle) {
        return res.status(404).json({ success: false, message: 'Cannot approve delete: vehicle not found' });
      }

      vehicle.isDeleted = true;
      vehicle.isActive = false;
      await vehicle.save();
    }

    requestDoc.status = 'APPROVED';
    requestDoc.decisionBy = req.user._id;
    requestDoc.decisionNote = String(note || '').trim();
    requestDoc.decidedAt = new Date();
    await requestDoc.save();

    await ManagerAuditLog.create({
      managerId: requestDoc.managerId,
      actorId: req.user._id,
      actorRole: 'super-admin',
      action: 'VEHICLE_REQUEST_APPROVED',
      entityType: 'VEHICLE_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: {
        type: requestDoc.type,
        vehicleId: requestDoc.vehicleId,
        note: requestDoc.decisionNote
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Request approved and applied',
      data: requestDoc
    });
  } catch (error) {
    next(error);
  }
};

exports.getAuditLogs = async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const managerId = req.query.managerId ? String(req.query.managerId) : '';
    const action = req.query.action ? String(req.query.action) : '';
    const entityType = req.query.entityType ? String(req.query.entityType).toUpperCase() : '';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;

    const filter = {};
    if (managerId) {
      filter.managerId = managerId;
    }
    if (action) {
      filter.action = action;
    }
    if (entityType) {
      filter.entityType = entityType;
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate && !Number.isNaN(startDate.getTime())) {
        filter.createdAt.$gte = startDate;
      }
      if (endDate && !Number.isNaN(endDate.getTime())) {
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endOfDay;
      }
      if (Object.keys(filter.createdAt).length === 0) {
        delete filter.createdAt;
      }
    }

    const logs = await ManagerAuditLog.find(filter)
      .populate('managerId', 'name email')
      .populate('actorId', 'name email role')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (error) {
    next(error);
  }
};

// @desc    List organizations, optionally filtered by service type
// @route   GET /api/super-admin/organizations?serviceType=SCHOOL
exports.getOrganizations = async (req, res, next) => {
  try {
    const organizations = await listOrganizations(req.query.serviceType);
    return res.status(200).json({ success: true, count: organizations.length, data: organizations });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new organization (school / university / office)
// @route   POST /api/super-admin/organizations
exports.createOrganization = async (req, res, next) => {
  try {
    const result = await createOrganizationRecord({
      name: req.body?.name,
      serviceType: req.body?.serviceType,
      createdBy: req.user?._id || null
    });

    if (result.error) {
      return res.status(result.error.status).json({ success: false, message: result.error.message });
    }

    return res.status(201).json({
      success: true,
      message: 'Organization created successfully',
      data: publicOrganization(result.organization)
    });
  } catch (error) {
    next(error);
  }
};
