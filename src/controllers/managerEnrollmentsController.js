const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Identity = require('../models/Identity');
const RiderProfile = require('../models/RiderProfile');

const STATUSES = ['PENDING', 'ACTIVE', 'REJECTED'];

// A managed rider profile has no email or phone of its own — the manager
// deciding a request still needs to know which account holder this profile
// belongs to (docs/modules/PROFILES.md), so this resolves the *account*'s
// email (from the shared Identity) and phone (from the primary sibling
// profile) for every MANAGED passenger in one batch. A PRIMARY passenger is
// its own account: no extra lookup.
async function resolveAccountsForPassengers(passengers) {
  const accountByPassengerId = new Map();

  const managed = passengers.filter((p) => p.profileKind === 'MANAGED' && p.identityId);
  const identityIds = [...new Set(managed.map((p) => String(p.identityId)))];

  let identityById = new Map();
  let primaryByIdentityId = new Map();
  if (identityIds.length) {
    const [identities, primaries] = await Promise.all([
      Identity.find({ _id: { $in: identityIds } }).select('email').lean(),
      User.find({ identityId: { $in: identityIds }, profileKind: 'PRIMARY' })
        .select('identityId phoneNumber name')
        .lean()
    ]);
    identityById = new Map(identities.map((i) => [String(i._id), i]));
    primaryByIdentityId = new Map(primaries.map((p) => [String(p.identityId), p]));
  }

  for (const passenger of passengers) {
    if (passenger.profileKind === 'MANAGED' && passenger.identityId) {
      const identity = identityById.get(String(passenger.identityId));
      const primary = primaryByIdentityId.get(String(passenger.identityId));
      accountByPassengerId.set(String(passenger._id), {
        name: primary?.name || '',
        email: identity?.email || '',
        phoneNumber: primary?.phoneNumber || ''
      });
    } else {
      accountByPassengerId.set(String(passenger._id), {
        name: passenger.name || '',
        email: passenger.email || '',
        phoneNumber: passenger.phoneNumber || ''
      });
    }
  }

  return accountByPassengerId;
}

const requestSummary = (enrollment, driver, passenger, account) => ({
  _id: enrollment._id,
  status: enrollment.status,
  requestedAt: enrollment.createdAt,
  decidedAt: enrollment.decidedAt || null,
  driver: driver ? { _id: driver._id, name: driver.name, driverCode: driver.driverCode || null } : null,
  passenger: passenger
    ? {
      _id: passenger._id,
      name: passenger.name,
      avatarUrl: passenger.avatarUrl || '',
      relation: passenger.relation || '',
      isManagedProfile: passenger.profileKind === 'MANAGED',
      // Kept populated from the owning account so the existing web-admin
      // column (which reads passenger.email) does not break for a managed
      // profile, which has no email of its own.
      email: passenger.email || account?.email || '',
      account: account || null
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

    const passengers = enrollments.length
      ? await User.find({ _id: { $in: enrollments.map((e) => e.userId) } })
        .select('name email avatarUrl relation profileKind identityId phoneNumber')
        .lean()
      : [];
    const passengerById = new Map(passengers.map((p) => [String(p._id), p]));
    const accountByPassengerId = await resolveAccountsForPassengers(passengers);

    const data = enrollments.map((enrollment) => {
      const passenger = passengerById.get(String(enrollment.userId));
      return requestSummary(
        enrollment,
        driverById.get(String(enrollment.driverId)),
        passenger,
        passenger ? accountByPassengerId.get(String(passenger._id)) : null
      );
    });

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

    const passenger = await User.findById(enrollment.userId)
      .select('name email avatarUrl relation profileKind identityId phoneNumber')
      .lean();
    const account = passenger
      ? (await resolveAccountsForPassengers([passenger])).get(String(passenger._id))
      : null;

    return res.status(200).json({
      success: true,
      message: approved ? 'Enrollment approved' : 'Enrollment declined',
      data: requestSummary(enrollment, driver, passenger, account)
    });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/manager/enrollment-requests/:id/approve
exports.approveManagerEnrollmentRequest = decide(true);

// @route POST /api/manager/enrollment-requests/:id/reject
exports.rejectManagerEnrollmentRequest = decide(false);
