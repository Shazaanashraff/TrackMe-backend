const Manager = require('../models/Manager');
const Driver = require('../models/Driver');
const Bus = require('../models/Bus');
const Booking = require('../models/Booking');
const BusReview = require('../models/BusReview');
const Route = require('../models/Route');
const ManagerBusRequest = require('../models/ManagerBusRequest');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const { createProvisionalCustomRoute } = require('../utils/customRoute');
const { isEmailRegistered } = require('../utils/accountRegistry');

const sanitizeManager = (manager) => ({
  _id: manager._id,
  name: manager.name,
  email: manager.email,
  role: 'admin',
  isActive: manager.isActive !== false,
  createdAt: manager.createdAt,
  updatedAt: manager.updatedAt
});

exports.createManager = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const existingManager = await isEmailRegistered(normalizedEmail);
    if (existingManager) {
      return res.status(409).json({
        success: false,
        message: 'A manager with this email already exists'
      });
    }

    const manager = await Manager.create({
      name: name.trim(),
      email: normalizedEmail,
      password,
      isActive: true,
      isEmailVerified: true
    });

    return res.status(201).json({
      success: true,
      message: 'Manager created successfully',
      data: sanitizeManager(manager)
    });
  } catch (error) {
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
    const manager = await Manager.findById(req.params.managerId).lean();
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const [fleetCounts, bookingKpis, reviewKpis] = await Promise.all([
      Bus.aggregate([
        { $match: { managerId: manager._id, isDeleted: false } },
        {
          $group: {
            _id: null,
            totalBuses: { $sum: 1 },
            activeBuses: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveBuses: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } }
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
            'busInfo.managerId': manager._id
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
      BusReview.aggregate([
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
            'busInfo.managerId': manager._id
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
        fleet: fleetCounts[0] || { totalBuses: 0, activeBuses: 0, inactiveBuses: 0 },
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
    const { name, email } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    if (email && email.toLowerCase().trim() !== manager.email) {
      const duplicate = await isEmailRegistered(email.toLowerCase().trim(), { excludeId: manager._id, excludeRole: 'admin' });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'Email already in use by another account' });
      }
    }

    if (name) manager.name = name.trim();
    if (email) manager.email = email.toLowerCase().trim();

    await manager.save();

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

exports.resetManagerPassword = async (req, res, next) => {
  try {
    const { password } = req.body;

    const manager = await Manager.findById(req.params.managerId).select('+password');
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    manager.password = password;
    await manager.save();

    return res.status(200).json({
      success: true,
      message: 'Manager password reset successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.assignBusesToManager = async (req, res, next) => {
  try {
    const { busIds } = req.body;

    const manager = await Manager.findById(req.params.managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const buses = await Bus.find({ _id: { $in: busIds }, isDeleted: false });
    if (buses.length !== busIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more bus IDs are invalid'
      });
    }

    await Bus.updateMany(
      { _id: { $in: busIds } },
      { $set: { managerId: manager._id } }
    );

    return res.status(200).json({
      success: true,
      message: 'Buses assigned to manager successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.getSuperAdminDashboard = async (req, res, next) => {
  try {
    const [managerCounts, busCounts, bookingSummary, reviewSummary] = await Promise.all([
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
      Bus.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            totalBuses: { $sum: 1 },
            activeBuses: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveBuses: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
            maintenanceBuses: {
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
      BusReview.aggregate([
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
        buses: busCounts[0] || { totalBuses: 0, activeBuses: 0, inactiveBuses: 0, maintenanceBuses: 0 },
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
      Bus.aggregate([
        { $match: { isDeleted: false, managerId: { $in: managerIds } } },
        {
          $group: {
            _id: '$managerId',
            totalBuses: { $sum: 1 },
            activeBuses: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            inactiveBuses: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } }
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
            'busInfo.managerId': { $in: managerIds }
          }
        },
        {
          $group: {
            _id: '$busInfo.managerId',
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
      BusReview.aggregate([
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
            'busInfo.managerId': { $in: managerIds }
          }
        },
        {
          $group: {
            _id: '$busInfo.managerId',
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
        totalBuses: 0,
        activeBuses: 0,
        inactiveBuses: 0
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

exports.getManagerBusDetails = async (req, res, next) => {
  try {
    const manager = await Manager.findById(req.params.managerId)
      .select('name email isActive createdAt')
      .lean();

    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const buses = await Bus.find({ managerId: manager._id, isDeleted: false })
      .populate('driverId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    const busIds = buses.map((bus) => bus._id);

    const [bookingByBus, reviewByBus] = await Promise.all([
      Booking.aggregate([
        { $match: { isDeleted: false, busId: { $in: busIds } } },
        {
          $group: {
            _id: '$busId',
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
      BusReview.aggregate([
        { $match: { isDeleted: false, busId: { $in: busIds } } },
        {
          $group: {
            _id: '$busId',
            averageRating: { $avg: '$rating' },
            reviewCount: { $sum: 1 }
          }
        }
      ])
    ]);

    const bookingMap = new Map(bookingByBus.map((item) => [String(item._id), item]));
    const reviewMap = new Map(reviewByBus.map((item) => [String(item._id), item]));

    const busDetails = buses.map((bus) => {
      const booking = bookingMap.get(String(bus._id)) || {
        totalBookings: 0,
        confirmedBookings: 0,
        cancelledBookings: 0,
        totalRevenue: 0
      };
      const review = reviewMap.get(String(bus._id)) || {
        averageRating: 0,
        reviewCount: 0
      };

      return {
        ...bus,
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
        buses: busDetails
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getPendingBusRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const type = String(req.query.type || 'ALL').toUpperCase();
    const managerId = req.query.managerId ? String(req.query.managerId) : '';
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'];
    const validTypes = ['CREATE_BUS_ACCOUNT', 'DELETE_BUS', 'ALL'];
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

    const requests = await ManagerBusRequest.find(filter)
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

exports.reviewBusRequest = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { decision, note } = req.body;

    const normalizedDecision = String(decision || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(normalizedDecision)) {
      return res.status(400).json({ success: false, message: 'decision must be APPROVE or REJECT' });
    }

    const requestDoc = await ManagerBusRequest.findById(requestId);
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
        action: 'BUS_REQUEST_REJECTED',
        entityType: 'BUS_REQUEST',
        entityId: requestDoc._id.toString(),
        metadata: {
          type: requestDoc.type,
          busId: requestDoc.busId,
          note: requestDoc.decisionNote
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Request rejected',
        data: requestDoc
      });
    }

    if (requestDoc.type === 'CREATE_BUS_ACCOUNT') {
      const busPayload = requestDoc.payload?.bus || {};
      const driverPayload = requestDoc.payload?.driver || {};
      if (!busPayload.numberPlate && busPayload.registrationNumber) {
        busPayload.numberPlate = String(busPayload.registrationNumber).toUpperCase();
      }
      if (!busPayload.registrationNumber && busPayload.busId) {
        busPayload.registrationNumber = `AUTO-${busPayload.busId}`;
      }

      const isCustomRoute = requestDoc.payload?.routeMode === 'CUSTOM';
      if (isCustomRoute) {
        const provisionalRoute = await createProvisionalCustomRoute({
          managerId: requestDoc.managerId,
          serviceType: busPayload.serviceType
        });
        busPayload.routeId = provisionalRoute.routeId;
      } else {
        const route = await Route.findOne({ routeId: busPayload.routeId, isDeleted: false });
        if (!route) {
          return res.status(400).json({ success: false, message: 'Cannot approve request: route no longer exists' });
        }
      }

      const duplicateBus = await Bus.findOne({
        $or: [
          { busId: busPayload.busId },
          { registrationNumber: busPayload.registrationNumber },
          { numberPlate: busPayload.numberPlate }
        ],
        isDeleted: false
      });
      if (duplicateBus) {
        return res.status(409).json({ success: false, message: 'Cannot approve request: bus already exists' });
      }

      const driverEmail = String(driverPayload.email || '').toLowerCase();
      let driver = await Driver.findOne({ email: driverEmail }).select('+password');
      if (!driver) {
        const takenByOtherAccountType = await isEmailRegistered(driverEmail);
        if (takenByOtherAccountType) {
          return res.status(409).json({ success: false, message: 'Cannot approve request: driver email belongs to another account type' });
        }

        driver = await Driver.create({
          name: driverPayload.name,
          email: driverEmail,
          phoneNumber: String(driverPayload.phoneNumber || '').trim(),
          nicNumber: String(driverPayload.nicNumber || '').trim(),
          licenseCardNumber: String(driverPayload.licenseCardNumber || '').trim(),
          password: driverPayload.password,
          isActive: true,
          isEmailVerified: true
        });
      } else {
        driver.password = driverPayload.password;
        driver.isActive = true;
        driver.isEmailVerified = true;
        if (driverPayload.phoneNumber) driver.phoneNumber = String(driverPayload.phoneNumber).trim();
        if (driverPayload.nicNumber) driver.nicNumber = String(driverPayload.nicNumber).trim();
        if (driverPayload.licenseCardNumber) driver.licenseCardNumber = String(driverPayload.licenseCardNumber).trim();
        await driver.save();
      }

      await Bus.create({
        ...busPayload,
        managerId: requestDoc.managerId,
        driverId: driver._id,
        isActive: true,
        isDeleted: false
      });
    }

    if (requestDoc.type === 'DELETE_BUS') {
      const bus = await Bus.findOne({ busId: requestDoc.busId, managerId: requestDoc.managerId, isDeleted: false });
      if (!bus) {
        return res.status(404).json({ success: false, message: 'Cannot approve delete: bus not found' });
      }

      bus.isDeleted = true;
      bus.isActive = false;
      await bus.save();
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
      action: 'BUS_REQUEST_APPROVED',
      entityType: 'BUS_REQUEST',
      entityId: requestDoc._id.toString(),
      metadata: {
        type: requestDoc.type,
        busId: requestDoc.busId,
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
