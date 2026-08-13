const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const RiderProfile = require('../models/RiderProfile');
const StudentOrganizationProfile = require('../models/StudentOrganizationProfile');
const HouseholdPlace = require('../models/HouseholdPlace');
const { mapValuesToObject } = require('../utils/students');

const STATUSES = ['PENDING', 'ACTIVE', 'REJECTED'];

const requestSummary = (enrollment, driver, student, account, organizationProfile, pickupPlace, dropoffPlace) => ({
  _id: enrollment._id,
  status: enrollment.status,
  requestedAt: enrollment.createdAt,
  decidedAt: enrollment.decidedAt || null,
  driver: driver ? { _id: driver._id, name: driver.name, driverCode: driver.driverCode || null } : null,
  passenger: student
    ? {
        _id: student._id,
        name: student.fullName,
        riderCode: student.riderCode,
        isManagedProfile: true,
        account: account ? { email: account.email || '', phoneNumber: student.guardianPhoneOverride || account.phoneNumber || '' } : null,
        organizationValues: mapValuesToObject(organizationProfile?.values),
        pickupPlace: pickupPlace || null,
        dropoffPlace: dropoffPlace || null
      }
    : null
});

// The enrollment must belong to a driver this manager owns. Checked against the
// driver rather than the denormalised managerId alone, so a stale copy of that
// field can never hand one manager another's request.
async function findOwnedEnrollment(managerId, enrollmentId) {
  const enrollment = await DriverEnrollment.findById(enrollmentId);
  if (!enrollment) return { enrollment: null, driver: null };

  const driver = await Driver.findOne({ _id: enrollment.driverId, managerId });
  if (!driver) return { enrollment: null, driver: null };

  return { enrollment, driver };
}

// Tells the passenger what happened. Best effort: a notification that fails to
// write must not roll back a decision the manager already made.
async function notifyPassenger(enrollment, driver, approved, student) {
  try {
    await Notification.create({
      userId: student.accountId,
      studentId: student._id,
      type: approved ? 'ENROLLMENT_APPROVED' : 'ENROLLMENT_REJECTED',
      title: approved ? 'Enrollment approved' : 'Enrollment declined',
      message: approved
        ? `${student.fullName} is now enrolled with ${driver.name}.`
        : `${student.fullName}'s request to enrol with ${driver.name} was declined.`,
      data: { relatedId: String(enrollment._id), studentId: String(student._id) },
      priority: 'MEDIUM'
    });
  } catch (error) {
    console.error('Failed to notify passenger of enrollment decision:', error.message);
  }
}

// @route GET /api/manager/enrollment-requests
exports.getManagerEnrollmentRequests = async (req, res, next) => {
  try {
    const requested = String(req.query.status || 'PENDING').toUpperCase();
    const status = STATUSES.includes(requested) ? requested : 'PENDING';

    // Scoped by the drivers this manager owns rather than the denormalised
    // managerId, so drivers moved between managers still list correctly.
    const drivers = await Driver.find({ managerId: req.user._id })
      .select('name driverCode')
      .lean();

    if (!drivers.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const driverById = new Map(drivers.map((d) => [String(d._id), d]));
    const enrollments = await DriverEnrollment.find({
      driverId: { $in: drivers.map((d) => d._id) },
      status
    })
      .sort({ createdAt: -1 })
      .lean();

    const students = enrollments.length
      ? await RiderProfile.find({ _id: { $in: enrollments.map((enrollment) => enrollment.studentId) } }).lean()
      : [];
    const studentById = new Map(students.map((student) => [String(student._id), student]));
    const [accounts, organizationProfiles, places] = await Promise.all([
      User.find({ _id: { $in: students.map((student) => student.accountId) } }).select('email phoneNumber').lean(),
      StudentOrganizationProfile.find({ _id: { $in: enrollments.map((enrollment) => enrollment.organizationProfileId).filter(Boolean) } }).lean(),
      HouseholdPlace.find({ _id: { $in: enrollments.flatMap((enrollment) => [enrollment.pickupPlaceId, enrollment.dropoffPlaceId]).filter(Boolean) } }).lean()
    ]);
    const accountById = new Map(accounts.map((account) => [String(account._id), account]));
    const orgProfileById = new Map(organizationProfiles.map((profile) => [String(profile._id), profile]));
    const placeById = new Map(places.map((place) => [String(place._id), place]));

    const data = enrollments.map((enrollment) =>
      requestSummary(
        enrollment,
        driverById.get(String(enrollment.driverId)),
        studentById.get(String(enrollment.studentId)),
        accountById.get(String(studentById.get(String(enrollment.studentId))?.accountId)),
        orgProfileById.get(String(enrollment.organizationProfileId)),
        placeById.get(String(enrollment.pickupPlaceId)),
        placeById.get(String(enrollment.dropoffPlaceId))
      )
    );

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/manager/enrollment-requests/count
// Drives the nav badge, so it stays a count rather than a full fetch.
exports.getManagerEnrollmentRequestCount = async (req, res, next) => {
  try {
    const driverIds = await Driver.find({ managerId: req.user._id }).distinct('_id');
    const count = driverIds.length
      ? await DriverEnrollment.countDocuments({ driverId: { $in: driverIds }, status: 'PENDING' })
      : 0;

    return res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    next(error);
  }
};

const decide = (approved) => async (req, res, next) => {
  try {
    const { enrollment, driver } = await findOwnedEnrollment(req.user._id, req.params.id);

    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment request not found' });
    }

    // Only a queued request can be decided. Deciding twice would otherwise let a
    // second click flip an already-approved passenger back out.
    if (enrollment.status !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `This request has already been ${enrollment.status === 'ACTIVE' ? 'approved' : 'declined'}`
      });
    }

    enrollment.status = approved ? 'ACTIVE' : 'REJECTED';
    enrollment.decidedBy = req.user._id;
    enrollment.decidedAt = new Date();
    // Realign the cached owner with the driver actually checked above.
    enrollment.managerId = driver.managerId || null;
    await enrollment.save();

    const student = await RiderProfile.findById(enrollment.studentId);
    if (student) await notifyPassenger(enrollment, driver, approved, student);

    const account = student ? await User.findById(student.accountId).select('email phoneNumber').lean() : null;

    return res.status(200).json({
      success: true,
      message: approved ? 'Enrollment approved' : 'Enrollment declined',
      data: requestSummary(enrollment, driver, student, account, null, null, null)
    });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/manager/enrollment-requests/:id/approve
exports.approveManagerEnrollmentRequest = decide(true);

// @route POST /api/manager/enrollment-requests/:id/reject
exports.rejectManagerEnrollmentRequest = decide(false);
