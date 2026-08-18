const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const User = require('../models/User');
const { generateUniqueRiderCode } = require('../utils/riderCode');
const { validateSignupDetails } = require('../utils/enrollmentSchema');
const {
  ensureLegacyRider,
  findOwnedRider,
  assertOwnedPlaces,
  validContactPhone,
  isSelfRider,
  publicRider
} = require('../utils/riders');

// A category always arrives with the details it requires, so the pair is read and
// checked together. Returns null when the request said nothing about either.
const readCategory = (body) => {
  if (body?.category === undefined && body?.details === undefined) return null;
  return validateSignupDetails(body?.category, body?.details);
};

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

    const category = readCategory(req.body);
    if (category && !category.valid) {
      return res.status(400).json({ success: false, message: 'Complete the details for the category you picked', errors: category.errors });
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
      category: category?.category || null,
      details: category && Object.keys(category.values).length ? category.values : undefined,
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
    const isSelf = isSelfRider(rider, req.user);
    let newAccountPhone = null;
    if (req.body?.contactPhone !== undefined || req.body?.guardianPhone !== undefined) {
      const phone = String(req.body.contactPhone ?? req.body.guardianPhone).trim();
      if (!validContactPhone(phone)) {
        return res.status(400).json({ success: false, message: 'Enter a valid contact phone number' });
      }
      // The account holder's own record has no separate phone to hold: their number
      // is the account's. Anyone else they added keeps it as an override.
      if (isSelf) {
        newAccountPhone = phone;
        rider.guardianPhoneOverride = '';
      } else {
        rider.guardianPhoneOverride = phone === String(req.user.phoneNumber || '').trim() ? '' : phone;
      }
    }
    if (req.body?.avatarUrl !== undefined) rider.avatarUrl = String(req.body.avatarUrl || '');

    const category = readCategory(req.body);
    if (category && !category.valid) {
      return res.status(400).json({ success: false, message: 'Complete the details for the category you picked', errors: category.errors });
    }
    if (category) {
      rider.category = category.category;
      rider.details = Object.keys(category.values).length ? category.values : undefined;
    }

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

    // One editor in the app means one write path here: editing yourself updates the
    // account too, so the account and the rider row cannot drift apart the way they
    // did when the profile screen offered two forms for the same person.
    if (isSelf) {
      const accountUpdates = {};
      if (req.body?.fullName !== undefined) accountUpdates.name = rider.fullName;
      if (newAccountPhone !== null) accountUpdates.phoneNumber = newAccountPhone;
      if (Object.keys(accountUpdates).length) {
        await User.updateOne({ _id: req.user._id }, { $set: accountUpdates });
        Object.assign(req.user, accountUpdates);
      }
    }

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
