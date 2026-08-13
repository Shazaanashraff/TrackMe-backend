const DriverEnrollment = require('../models/DriverEnrollment');
const StudentProfile = require('../models/StudentProfile');
const { generateUniqueRiderCode } = require('../utils/riderCode');
const {
  ensureLegacyStudent,
  findOwnedStudent,
  assertOwnedPlaces,
  validGuardianPhone,
  publicStudent
} = require('../utils/students');

exports.listStudents = async (req, res, next) => {
  try {
    await ensureLegacyStudent(req.user);
    const students = await StudentProfile.find({
      accountId: req.user._id,
      isActive: { $ne: false }
    }).sort({ createdAt: 1 });

    return res.status(200).json({
      success: true,
      data: students.map((student) => publicStudent(student, req.user)),
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

exports.createStudent = async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const guardianPhone = String(req.body?.guardianPhone || req.user.phoneNumber || '').trim();
    if (!fullName) {
      return res.status(400).json({ success: false, message: 'Student full name is required', errors: { fullName: 'Required' } });
    }
    if (!validGuardianPhone(guardianPhone)) {
      return res.status(400).json({ success: false, message: 'A valid guardian phone number is required', errors: { guardianPhone: 'Enter a valid phone number' } });
    }

    const pickupId = req.body?.defaultPickupPlaceId || null;
    const dropoffId = req.body?.defaultDropoffPlaceId || null;
    const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupId, dropoffId]);
    if (!ownedPlaces.valid) {
      return res.status(400).json({ success: false, message: 'Pickup or drop-off location does not belong to this account' });
    }

    const student = await StudentProfile.create({
      accountId: req.user._id,
      riderCode: await generateUniqueRiderCode(StudentProfile),
      fullName,
      guardianPhoneOverride: guardianPhone === String(req.user.phoneNumber || '').trim() ? '' : guardianPhone,
      avatarUrl: String(req.body?.avatarUrl || ''),
      defaultPickupPlaceId: pickupId,
      defaultDropoffPlaceId: dropoffId
    });

    return res.status(201).json({ success: true, data: publicStudent(student, req.user) });
  } catch (error) {
    next(error);
  }
};

exports.updateStudent = async (req, res, next) => {
  try {
    const student = await findOwnedStudent(req.user, req.params.studentId);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    if (req.body?.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return res.status(400).json({ success: false, message: 'Student full name is required' });
      student.fullName = fullName;
    }
    if (req.body?.guardianPhone !== undefined) {
      const phone = String(req.body.guardianPhone).trim();
      if (!validGuardianPhone(phone)) {
        return res.status(400).json({ success: false, message: 'Enter a valid guardian phone number' });
      }
      student.guardianPhoneOverride = phone === String(req.user.phoneNumber || '').trim() ? '' : phone;
    }
    if (req.body?.avatarUrl !== undefined) student.avatarUrl = String(req.body.avatarUrl || '');

    const pickupId = req.body?.defaultPickupPlaceId;
    const dropoffId = req.body?.defaultDropoffPlaceId;
    if (pickupId !== undefined || dropoffId !== undefined) {
      const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupId, dropoffId]);
      if (!ownedPlaces.valid) {
        return res.status(400).json({ success: false, message: 'Pickup or drop-off location does not belong to this account' });
      }
      if (pickupId !== undefined) student.defaultPickupPlaceId = pickupId || null;
      if (dropoffId !== undefined) student.defaultDropoffPlaceId = dropoffId || null;
    }

    await student.save();
    return res.status(200).json({ success: true, data: publicStudent(student, req.user) });
  } catch (error) {
    next(error);
  }
};

exports.archiveStudent = async (req, res, next) => {
  try {
    const student = await findOwnedStudent(req.user, req.params.studentId);
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    const hasEnrollment = await DriverEnrollment.exists({
      studentId: student._id,
      status: { $in: ['ACTIVE', 'PENDING'] }
    });
    if (hasEnrollment) {
      return res.status(409).json({ success: false, message: 'Remove this student from their shuttles before archiving the profile' });
    }

    student.isActive = false;
    await student.save();
    return res.status(200).json({ success: true, message: 'Student archived' });
  } catch (error) {
    next(error);
  }
};
