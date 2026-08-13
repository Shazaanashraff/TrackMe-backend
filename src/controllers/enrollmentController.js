const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Vehicle = require('../models/Vehicle');
const Organization = require('../models/Organization');
const RiderOrganizationProfile = require('../models/StudentOrganizationProfile');
const { publicOrganization } = require('../utils/organizations');
const { findDriverIdByEnrollmentKey } = require('../utils/enrollmentKey');
const { findHouseholdProfiles } = require('../utils/identityRegistry');
const { riderTagForServiceType } = require('../utils/riderTag');

const INVALID_KEY = 'That enrollment key is not valid';
const MAX_FAILED_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const failedAttempts = new Map();

function attemptState(accountId) {
  const key = String(accountId);
  const record = failedAttempts.get(key);
  if (!record) return null;
  if (Date.now() - record.firstAt > ATTEMPT_WINDOW_MS) {
    failedAttempts.delete(key);
    return null;
  }
  return record;
}

function recordFailure(accountId) {
  const key = String(accountId);
  const record = attemptState(accountId);
  failedAttempts.set(key, record
    ? { ...record, count: record.count + 1 }
    : { count: 1, firstAt: Date.now() });
}

const clearFailures = (accountId) => failedAttempts.delete(String(accountId));
const isThrottled = (accountId) => (attemptState(accountId)?.count || 0) >= MAX_FAILED_ATTEMPTS;
const resetAttempts = () => failedAttempts.clear();

const driverSummary = (driver, organization, vehicle, includeContact = false) => ({
  _id: driver._id,
  name: driver.name,
  driverCode: driver.driverCode || null,
  phoneNumber: includeContact ? driver.phoneNumber || null : null,
  organization: publicOrganization(organization),
  vehicle: vehicle
    ? {
        _id: vehicle._id,
        vehicleId: vehicle.vehicleId,
        numberPlate: vehicle.numberPlate,
        routeId: vehicle.routeId || null
      }
    : null
});

const enrollmentSummary = (enrollment, driver, organization, vehicle) => ({
  _id: enrollment._id,
  riderId: enrollment.studentId,
  // Compatibility for clients released before rider-neutral terminology.
  studentId: enrollment.studentId,
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
    const context = await resolveKeyContext(req.user, req.body?.key, req.body?.riderId || req.body?.studentId);
    if (context.error) return res.status(context.error.status).json({ success: false, message: context.error.message });
    const config = context.organization ? normalizedEnrollmentConfig(context.organization) : { schemaVersion: 1, fields: [] };
    return res.status(200).json({
      success: true,
      data: {
        rider: publicRider(context.rider, req.user),
        // Compatibility for clients released before rider-neutral terminology.
        student: publicRider(context.rider, req.user),
        driver: driverSummary(context.driver, context.organization, context.vehicle, false),
        schemaVersion: config.schemaVersion,
        fields: config.fields.filter((field) => field.enabled),
        existingValues: mapValuesToObject(context.organizationProfile?.values),
        needsUpdate: Boolean(context.organizationProfile?.needsUpdate),
        existingEnrollment: context.existingEnrollment
          ? enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle)
          : null
      }
    });
  } catch (error) { next(error); }
};

async function createEnrollment(req, { legacy = false } = {}) {
  const riderId = req.params?.riderId || req.params?.studentId || req.body?.riderId || req.body?.studentId;
  const context = await resolveKeyContext(req.user, req.body?.key, riderId);
  if (context.error) return context;

  if (!validContactPhone(effectiveContactPhone(context.rider, req.user))) {
    const role = riderRoleForResolvedService(context.organization?.serviceType);
    return { error: { status: 400, message: `Add a valid contact phone number before enrolling this ${role}`, errors: { guardianPhone: 'Required' } } };
  }

  const pickupPlaceId = req.body?.pickupPlaceId ?? context.rider.defaultPickupPlaceId ?? null;
  const dropoffPlaceId = req.body?.dropoffPlaceId ?? context.rider.defaultDropoffPlaceId ?? null;
  const ownedPlaces = await assertOwnedPlaces(req.user._id, [pickupPlaceId, dropoffPlaceId]);
  if (!ownedPlaces.valid) {
    return { error: { status: 400, message: 'Pickup or drop-off location does not belong to this account' } };
  }

  let organizationProfile = null;
  if (context.organization) {
    const config = normalizedEnrollmentConfig(context.organization);
    if (!legacy && Number(req.body?.schemaVersion) !== config.schemaVersion) {
      return { error: { status: 409, message: 'The organization updated its enrollment form. Review the latest fields and try again.', code: 'SCHEMA_STALE' } };
    }
    const validation = validateEnrollmentResponses(config, req.body?.responses);
    if (!legacy && !validation.valid) {
      return { error: { status: 400, message: 'Complete the required enrollment fields', errors: validation.errors } };
    }
    organizationProfile = await RiderOrganizationProfile.findOneAndUpdate(
      { studentId: context.rider._id, organizationId: context.organization._id },
      {
        $set: {
          schemaVersion: config.schemaVersion,
          values: legacy ? (context.organizationProfile?.values || {}) : validation.values,
          needsUpdate: false,
          legacyGrandfathered: legacy
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  if (context.existingEnrollment?.status === 'ACTIVE') {
    return { error: { status: 409, message: `${context.rider.fullName} is already enrolled with ${context.driver.name}`, data: enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle) } };
  }
  if (context.existingEnrollment?.status === 'PENDING') {
    return {
      success: true,
      status: 200,
      message: `${context.rider.fullName}'s request is waiting for approval`,
      data: enrollmentSummary(context.existingEnrollment, context.driver, context.organization, context.vehicle)
    };
  }

  const requiredApproval = Boolean(context.driver.isPrivate);
  const status = requiredApproval ? 'PENDING' : 'ACTIVE';
  const enrollment = await DriverEnrollment.findOneAndUpdate(
    { studentId: context.rider._id, driverId: context.driver._id },
    {
      $set: {
        userId: null,
        studentId: context.rider._id,
        driverId: context.driver._id,
        managerId: context.driver.managerId || null,
        status,
        requiredApproval,
        organizationProfileId: organizationProfile?._id || null,
        pickupPlaceId,
        dropoffPlaceId,
        decidedBy: null,
        decidedAt: null
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return {
    success: true,
    status: 201,
    message: requiredApproval
      ? `${context.rider.fullName}'s request was sent for approval.`
      : `${context.rider.fullName} is now enrolled with ${context.driver.name}`,
    data: enrollmentSummary(enrollment, context.driver, context.organization, context.vehicle)
  };
}

exports.enrollStudent = async (req, res, next) => {
  try {
    const result = await createEnrollment(req);
    if (result.error) return res.status(result.error.status).json({ success: false, ...result.error });
    return res.status(result.status).json({ success: true, message: result.message, data: result.data });
  } catch (error) { next(error); }
};

// Rider-neutral endpoint used by current clients. The legacy function remains
// exported because older app versions still call /students/:studentId.
exports.enrollRider = exports.enrollStudent;

// Temporary compatibility endpoint for an app build released before the
// student wizard. It enrolls the account's first migrated student without
// enforcing newly-configured organization fields.
exports.redeemEnrollmentKey = async (req, res, next) => {
  try {
    const result = await createEnrollment(req, { legacy: true });
    if (result.error) return res.status(result.error.status).json({ success: false, ...result.error });
    return res.status(result.status).json({ success: true, message: result.message, data: result.data });
  } catch (error) { next(error); }
};

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

exports.leaveEnrollment = async (req, res, next) => {
  try {
    const studentIds = await require('../models/RiderProfile').find({ accountId: req.user._id }).distinct('_id');
    const enrollment = await DriverEnrollment.findOneAndDelete({ _id: req.params.id, studentId: { $in: studentIds } });
    if (!enrollment) return res.status(404).json({ success: false, message: 'Enrollment not found' });
    return res.status(200).json({ success: true, message: 'Enrollment removed' });
  } catch (error) { next(error); }
};

exports.resetAttempts = resetAttempts;
