const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Vehicle = require('../models/Vehicle');
const Organization = require('../models/Organization');
const { publicOrganization } = require('../utils/organizations');
const { findDriverIdByEnrollmentKey } = require('../utils/enrollmentKey');
const { findHouseholdProfiles } = require('../utils/identityRegistry');
const { riderTagForServiceType } = require('../utils/riderTag');

// One message for every reason a key does not work, so a caller cannot use the
// response to learn which keys exist or which drivers are private.
const INVALID_KEY = 'That enrollment key is not valid';

// The key is a bearer credential, so a passenger who starts guessing gets slowed
// down. Held in memory rather than a collection: this only needs to blunt online
// guessing, and the key space (12 characters over a 32-symbol alphabet) already
// makes exhaustion hopeless. A restart clearing the counters is acceptable for
// that job; if this ever needs to hold across instances it wants a shared store.
const MAX_FAILED_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const failedAttempts = new Map();

function attemptState(userId) {
  const record = failedAttempts.get(String(userId));
  if (!record) return null;
  if (Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
    failedAttempts.delete(String(userId));
    return null;
  }
  return record;
}

function recordFailure(userId) {
  const key = String(userId);
  const record = attemptState(userId);
  if (!record) {
    failedAttempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count += 1;
}

const clearFailures = (userId) => failedAttempts.delete(String(userId));

const isThrottled = (userId) => (attemptState(userId)?.count || 0) >= MAX_FAILED_ATTEMPTS;

// Exposed so tests can start from a clean slate rather than sharing counters.
const resetAttempts = () => failedAttempts.clear();

const driverSummary = (driver, organization, vehicle) => ({
  _id: driver._id,
  name: driver.name,
  driverCode: driver.driverCode || null,
  organization: publicOrganization(organization),
  vehicle: vehicle
    ? { _id: vehicle._id, vehicleId: vehicle.vehicleId, numberPlate: vehicle.numberPlate }
    : null
});

const enrollmentSummary = (enrollment, driver, organization, vehicle) => ({
  _id: enrollment._id,
  status: enrollment.status,
  requiredApproval: enrollment.requiredApproval,
  requestedAt: enrollment.createdAt,
  decidedAt: enrollment.decidedAt || null,
  driver: driver ? driverSummary(driver, organization, vehicle) : null,
  // Derived from the driver's organization, never stored — see utils/riderTag.js.
  riderTag: riderTagForServiceType(organization?.serviceType)
});

// Shared by getMyEnrollments (one profile) and getHouseholdEnrollments
// (every profile on an identity): fetches ACTIVE/PENDING enrollments for a
// set of profile ids and batch-loads the drivers/organizations/vehicles they
// reference, returning one summary list per profile id. Keeping this in one
// place is what makes the household view's per-profile grouping consistent
// with what a single profile's own "my shuttle" list already shows.
const loadEnrollmentsByProfile = async (profileIds) => {
  const byProfile = new Map(profileIds.map((id) => [String(id), []]));
  if (!profileIds.length) return byProfile;

  const enrollments = await DriverEnrollment.find({
    userId: { $in: profileIds },
    status: { $in: ['ACTIVE', 'PENDING'] }
  }).sort({ createdAt: -1 }).lean();

  if (!enrollments.length) return byProfile;

  const driverIds = enrollments.map((item) => item.driverId);
  const drivers = await Driver.find({ _id: { $in: driverIds } })
    .select('name driverCode organization isActive')
    .lean();

  const orgIds = drivers.map((d) => d.organization).filter(Boolean);
  const [organizations, vehicles] = await Promise.all([
    orgIds.length
      ? Organization.find({ _id: { $in: orgIds } }).select('name serviceType').lean()
      : [],
    Vehicle.find({ driverId: { $in: driverIds } }).select('vehicleId numberPlate driverId').lean()
  ]);

  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const orgById = new Map(organizations.map((o) => [String(o._id), o]));
  const vehicleByDriver = new Map(vehicles.map((v) => [String(v.driverId), v]));

  for (const enrollment of enrollments) {
    const driver = driverById.get(String(enrollment.driverId));
    const organization = driver?.organization ? orgById.get(String(driver.organization)) : null;
    const summary = enrollmentSummary(enrollment, driver, organization, vehicleByDriver.get(String(enrollment.driverId)));

    const key = String(enrollment.userId);
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(summary);
  }

  return byProfile;
};

// @route POST /api/enrollments/redeem
exports.redeemEnrollmentKey = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const raw = String(req.body?.key || '').trim();

    if (!raw) {
      return res.status(400).json({ success: false, message: 'Please provide an enrollment key' });
    }

    if (isThrottled(userId)) {
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect keys. Please wait a few minutes and try again.'
      });
    }

    const driverId = await findDriverIdByEnrollmentKey(raw);
    const driver = driverId ? await Driver.findById(driverId) : null;

    // An inactive driver is treated exactly like an unknown key: a passenger has
    // no business learning that a suspended driver exists.
    if (!driver || driver.isActive === false) {
      recordFailure(userId);
      return res.status(404).json({ success: false, message: INVALID_KEY });
    }

    clearFailures(userId);

    const [organization, vehicle, existing] = await Promise.all([
      driver.organization
        ? Organization.findById(driver.organization).select('name serviceType').lean()
        : null,
      Vehicle.findOne({ driverId: driver._id }).select('vehicleId numberPlate').lean(),
      DriverEnrollment.findOne({ userId, driverId: driver._id })
    ]);

    if (existing?.status === 'ACTIVE') {
      return res.status(409).json({
        success: false,
        message: `You are already enrolled with ${driver.name}`,
        data: enrollmentSummary(existing, driver, organization, vehicle)
      });
    }

    // Re-submitting while a request is queued is a no-op rather than an error, so
    // a double tap on a slow connection does not read as a failure.
    if (existing?.status === 'PENDING') {
      return res.status(200).json({
        success: true,
        message: `Your request is waiting for ${driver.name}'s manager to approve it`,
        data: enrollmentSummary(existing, driver, organization, vehicle)
      });
    }

    const requiredApproval = Boolean(driver.isPrivate);
    const status = requiredApproval ? 'PENDING' : 'ACTIVE';

    // Upsert rather than create: a previously REJECTED row is revived here, which
    // also lets the unique (userId, driverId) index stand guard against duplicates.
    const enrollment = await DriverEnrollment.findOneAndUpdate(
      { userId, driverId: driver._id },
      {
        $set: {
          userId,
          driverId: driver._id,
          managerId: driver.managerId || null,
          status,
          requiredApproval,
          decidedBy: null,
          decidedAt: null
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
      success: true,
      message: requiredApproval
        ? `Request sent. ${driver.name}'s manager needs to approve it.`
        : `You are now enrolled with ${driver.name}`,
      data: enrollmentSummary(enrollment, driver, organization, vehicle)
    });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/enrollments/mine
// Returns joined shuttles and anything still awaiting approval. Rejected records
// are left out: to the passenger the request simply did not succeed.
exports.getMyEnrollments = async (req, res, next) => {
  try {
    const byProfile = await loadEnrollmentsByProfile([req.user._id]);
    return res.status(200).json({ success: true, data: byProfile.get(String(req.user._id)) || [] });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/profiles/household/enrollments
// Every profile on the caller's identity — the account holder plus everyone
// they manage — with its own ACTIVE/PENDING enrollments, so the app can show
// one map with every household member's shuttle at once (see
// docs/modules/PROFILES.md). An identity-less caller (a pre-migration
// account, in principle) gets an empty list rather than an unscoped query —
// there is no household to return.
exports.getHouseholdEnrollments = async (req, res, next) => {
  try {
    if (!req.identityId) {
      return res.status(200).json({ success: true, data: [] });
    }

    const profiles = await findHouseholdProfiles(req.identityId);
    if (!profiles.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    const byProfile = await loadEnrollmentsByProfile(profiles.map((p) => p._id));

    const data = profiles.map((profile) => ({
      profile: {
        _id: profile._id,
        name: profile.name,
        relation: profile.relation || '',
        profileKind: profile.profileKind,
        hasAvatar: Boolean(profile.avatarUrl)
      },
      enrollments: byProfile.get(String(profile._id)) || []
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/enrollments/:id
// Leaving and cancelling a pending request are the same action to the passenger,
// so both drop the record and let them start over later.
exports.leaveEnrollment = async (req, res, next) => {
  try {
    const enrollment = await DriverEnrollment.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }

    return res.status(200).json({ success: true, message: 'Enrollment removed' });
  } catch (error) {
    next(error);
  }
};

exports.resetAttempts = resetAttempts;
