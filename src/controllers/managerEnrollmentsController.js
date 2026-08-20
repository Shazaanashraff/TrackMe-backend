const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Identity = require('../models/Identity');
const RiderProfile = require('../models/RiderProfile');
const RiderOrganizationProfile = require('../models/StudentOrganizationProfile');
const Organization = require('../models/Organization');
const { mapValuesToObject } = require('../utils/riders');
const { normalizedEnrollmentConfig } = require('../utils/enrollmentSchema');

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

// Who a queued request is actually for.
//
// The enrolment's owner is `studentId` (a RiderProfile) — `userId` is the
// deprecated account-level owner, and `createEnrollment` writes it as null, so
// resolving by it alone showed the manager `passenger: null` for every request
// the current app makes. Rows written by the legacy `/redeem` path still carry a
// `userId`, so that lookup stays as the fallback rather than being dropped.
async function resolvePassengers(enrollments) {
  const riderIds = [...new Set(enrollments.map((e) => e.studentId).filter(Boolean).map(String))];
  const legacyUserIds = [...new Set(
    enrollments.filter((e) => !e.studentId).map((e) => e.userId).filter(Boolean).map(String)
  )];
  const organizationProfileIds = [...new Set(
    enrollments.map((e) => e.organizationProfileId).filter(Boolean).map(String)
  )];

  const [riders, legacyPassengers, organizationProfiles] = await Promise.all([
    riderIds.length
      ? RiderProfile.find({ _id: { $in: riderIds } })
        .select('fullName riderCode avatarUrl accountId guardianPhoneOverride category details')
        .lean()
      : [],
    legacyUserIds.length
      ? User.find({ _id: { $in: legacyUserIds } })
        .select('name email avatarUrl relation profileKind identityId phoneNumber')
        .lean()
      : [],
    organizationProfileIds.length
      ? RiderOrganizationProfile.find({ _id: { $in: organizationProfileIds } })
        .select('values organizationId')
        .lean()
      : []
  ]);

  const accountIds = [...new Set(riders.map((r) => r.accountId).filter(Boolean).map(String))];
  const accounts = accountIds.length
    ? await User.find({ _id: { $in: accountIds } }).select('name email phoneNumber').lean()
    : [];

  // The form answers are stored keyed by field key ("grade"), so the manager
  // deciding a request would otherwise see the bare key and no sign of which
  // organization asked for it. The organization carries both: its name, and the
  // label and order it configured for each field.
  const organizationIds = [...new Set(
    organizationProfiles.map((p) => p.organizationId).filter(Boolean).map(String)
  )];
  const organizations = organizationIds.length
    ? await Organization.find({ _id: { $in: organizationIds } })
      .select('name serviceType enrollmentConfig')
      .lean()
    : [];

  const riderById = new Map(riders.map((r) => [String(r._id), r]));
  const accountById = new Map(accounts.map((a) => [String(a._id), a]));
  const organizationById = new Map(organizations.map((o) => [String(o._id), o]));
  const organizationByProfileId = new Map(
    organizationProfiles.map((p) => [String(p._id), organizationById.get(String(p.organizationId)) || null])
  );
  const valuesByProfileId = new Map(
    organizationProfiles.map((p) => [String(p._id), mapValuesToObject(p.values)])
  );
  const legacyById = new Map(legacyPassengers.map((p) => [String(p._id), p]));
  const legacyAccounts = await resolveAccountsForPassengers(legacyPassengers);

  // Labelled and ordered the way the organization's own enrolment form is, with
  // an answer to a field it has since removed kept at the end rather than
  // dropped: it is still what this request was raised with.
  const detailsFor = (organization, values) => {
    // Normalized rather than read straight off the document: an organization
    // that has never opened the form builder stores no config at all, and the
    // catalog default is where "grade" gets to be labelled "Grade" — the same
    // label the passenger answered it under.
    const fields = organization ? normalizedEnrollmentConfig(organization).fields : [];
    const labelled = fields
      .filter((field) => Object.prototype.hasOwnProperty.call(values, field.key))
      .map((field) => ({ key: field.key, label: field.label || field.key, value: values[field.key] }));
    const known = new Set(labelled.map((entry) => entry.key));
    const rest = Object.entries(values)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => ({ key, label: key, value }));
    return [...labelled, ...rest].filter((entry) => String(entry.value == null ? '' : entry.value).trim() !== '');
  };

  return (enrollment) => {
    const profileId = String(enrollment.organizationProfileId);
    const organization = organizationByProfileId.get(profileId) || null;
    const organizationValues = valuesByProfileId.get(profileId) || {};
    const organizationSummary = organization
      ? { _id: organization._id, name: organization.name, serviceType: organization.serviceType || '' }
      : null;
    const organizationDetails = detailsFor(organization, organizationValues);

    const rider = riderById.get(String(enrollment.studentId));
    if (rider) {
      const account = accountById.get(String(rider.accountId)) || null;
      return {
        passenger: {
          _id: rider._id,
          name: rider.fullName,
          riderCode: rider.riderCode || '',
          avatarUrl: rider.avatarUrl || '',
          relation: '',
          // The account holder's own rider row is created with the account's id
          // (utils/riders.js), so anyone else is someone they added.
          isManagedProfile: String(rider._id) !== String(rider.accountId),
          email: account?.email || '',
          contactPhone: rider.guardianPhoneOverride || account?.phoneNumber || '',
          // What the rider answered on this organization's enrolment form: the
          // grade or employee ID the manager is being asked to approve.
          // `organizationDetails` is the labelled, ordered form of the same
          // answers; the raw map stays for anything reading them by field key.
          organizationValues,
          organizationDetails
        },
        account: account
          ? { name: account.name || '', email: account.email || '', phoneNumber: account.phoneNumber || '' }
          : null,
        organization: organizationSummary
      };
    }

    const legacy = legacyById.get(String(enrollment.userId));
    if (!legacy) return { passenger: null, account: null, organization: organizationSummary };
    const account = legacyAccounts.get(String(legacy._id)) || null;
    return {
      passenger: {
        _id: legacy._id,
        name: legacy.name,
        riderCode: '',
        avatarUrl: legacy.avatarUrl || '',
        relation: legacy.relation || '',
        isManagedProfile: legacy.profileKind === 'MANAGED',
        email: legacy.email || account?.email || '',
        contactPhone: legacy.phoneNumber || account?.phoneNumber || '',
        organizationValues,
        organizationDetails
      },
      account,
      organization: organizationSummary
    };
  };
}

const requestSummary = (enrollment, driver, passenger, account, organization = null) => ({
  _id: enrollment._id,
  status: enrollment.status,
  requestedAt: enrollment.createdAt,
  decidedAt: enrollment.decidedAt || null,
  driver: driver ? { _id: driver._id, name: driver.name, driverCode: driver.driverCode || null } : null,
  // Which organization's form the answers below belong to. A manager can run
  // more than one, so the queue names it per request instead of assuming.
  organization,
  // `passenger` is already normalized by resolvePassengers, whichever owner
  // field the row carries. `email` there is the owning account's, so the
  // web-admin column keeps working for a rider that has no email of its own.
  passenger: passenger ? { ...passenger, account: account || null } : null
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
      .select('name driverCode organization')
      .populate('organization', 'name serviceType')
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

    const resolve = await resolvePassengers(enrollments);

    const data = enrollments.map((enrollment) => {
      const { passenger, account, organization } = resolve(enrollment);
      const driver = driverById.get(String(enrollment.driverId));
      // A legacy row carries no organization profile to read the name from; the
      // driver it was raised against belongs to one either way.
      const driverOrganization = driver?.organization
        ? {
          _id: driver.organization._id,
          name: driver.organization.name,
          serviceType: driver.organization.serviceType || ''
        }
        : null;
      return requestSummary(enrollment, driver, passenger, account, organization || driverOrganization);
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

    const resolve = await resolvePassengers([enrollment]);
    const { passenger, account, organization } = resolve(enrollment);

    return res.status(200).json({
      success: true,
      message: approved ? 'Enrollment approved' : 'Enrollment declined',
      data: requestSummary(enrollment, driver, passenger, account, organization)
    });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/manager/enrollment-requests/:id/approve
exports.approveManagerEnrollmentRequest = decide(true);

// @route POST /api/manager/enrollment-requests/:id/reject
exports.rejectManagerEnrollmentRequest = decide(false);
