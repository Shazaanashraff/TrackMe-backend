const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const { generateUniqueRiderCode } = require('../utils/riderCode');
const {
  ensureLegacyRider,
  findOwnedRider,
  assertOwnedPlaces,
  validContactPhone,
  publicRider
} = require('../utils/riders');

const listRiders = async (req, res, next) => {
  try {
    await ensureLegacyRider(req.user);
    const riders = await RiderProfile.find({
      accountId: req.user._id,
      isActive: { $ne: false }
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      data: riders.map((rider) => publicRider(rider, req.user)),
      account: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        phoneNumber: req.user.phoneNumber || ''
      }
    });
  } catch (error) {
    next(error);
  }
};

const createRider = async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const contactPhone = String(req.body?.contactPhone || req.body?.guardianPhone || req.user.phoneNumber || '').trim();
    if (!fullName) {
      return res.status(400).json({ success: false, message: 'Rider full name is required', errors: { fullName: 'Required' } });
    }
    if (!validContactPhone(contactPhone)) {
      return res.status(400).json({ success: false, message: 'A valid contact phone number is required', errors: { guardianPhone: 'Enter a valid phone number' } });
    }

    const pickupId = req.body?.defaultPickupPlaceId || null;
    const dropoffId = req.body?.defaultDropoffPlaceId || null;
    const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupId, dropoffId]);
    if (!ownedPlaces.valid) {
      return res.status(400).json({ success: false, message: 'Pickup or drop-off location does not belong to this account' });
    }

    const rider = await RiderProfile.create({
      accountId: req.user._id,
      riderCode: await generateUniqueRiderCode(RiderProfile),
      fullName,
      guardianPhoneOverride: contactPhone === String(req.user.phoneNumber || '').trim() ? '' : contactPhone,
      avatarUrl: String(req.body?.avatarUrl || ''),
      defaultPickupPlaceId: pickupId,
      defaultDropoffPlaceId: dropoffId
    });

    return res.status(201).json({ success: true, data: publicRider(rider, req.user) });
  } catch (error) {
    next(error);
  }
};

const updateRider = async (req, res, next) => {
  try {
    const riderId = req.params.riderId || req.params.studentId;
    const rider = await findOwnedRider(req.user, riderId);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    if (req.body?.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return res.status(400).json({ success: false, message: 'Rider full name is required' });
      rider.fullName = fullName;
    }
    if (req.body?.contactPhone !== undefined || req.body?.guardianPhone !== undefined) {
      const phone = String(req.body.contactPhone ?? req.body.guardianPhone).trim();
      if (!validContactPhone(phone)) {
        return res.status(400).json({ success: false, message: 'Enter a valid contact phone number' });
      }
      rider.guardianPhoneOverride = phone === String(req.user.phoneNumber || '').trim() ? '' : phone;
    }
    if (req.body?.avatarUrl !== undefined) rider.avatarUrl = String(req.body.avatarUrl || '');

    const pickupId = req.body?.defaultPickupPlaceId;
    const dropoffId = req.body?.defaultDropoffPlaceId;
    if (pickupId !== undefined || dropoffId !== undefined) {
      const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupId, dropoffId]);
      if (!ownedPlaces.valid) {
        return res.status(400).json({ success: false, message: 'Pickup or drop-off location does not belong to this account' });
      }
      if (pickupId !== undefined) rider.defaultPickupPlaceId = pickupId || null;
      if (dropoffId !== undefined) rider.defaultDropoffPlaceId = dropoffId || null;
    }

    await rider.save();
    return res.status(200).json({ success: true, data: publicRider(rider, req.user) });
  } catch (error) {
    next(error);
  }
};

const archiveRider = async (req, res, next) => {
  try {
    const riderId = req.params.riderId || req.params.studentId;
    const rider = await findOwnedRider(req.user, riderId);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    const hasEnrollment = await DriverEnrollment.exists({
      studentId: rider._id,
      status: { $in: ['ACTIVE', 'PENDING'] }
    });
    if (hasEnrollment) {
      return res.status(409).json({ success: false, message: 'Remove this rider from their shuttles before archiving the profile' });
    }

    rider.isActive = false;
    await rider.save();
    return res.status(200).json({ success: true, message: 'Rider archived' });
  } catch (error) {
    next(error);
  }
};

exports.listRiders = listRiders;
exports.createRider = createRider;
exports.updateRider = updateRider;
exports.archiveRider = archiveRider;

// Compatibility exports for the legacy /api/students route.
exports.listStudents = listRiders;
exports.createStudent = createRider;
exports.updateStudent = updateRider;
exports.archiveStudent = archiveRider;
