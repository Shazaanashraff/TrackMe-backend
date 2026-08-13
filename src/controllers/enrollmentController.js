const Driver = require('../models/Driver');
const DriverEnrollment = require('../models/DriverEnrollment');
const Vehicle = require('../models/Vehicle');
const Organization = require('../models/Organization');
const RiderOrganizationProfile = require('../models/StudentOrganizationProfile');
const { publicOrganization } = require('../utils/organizations');
const { findDriverIdByEnrollmentKey } = require('../utils/enrollmentKey');
const { normalizedEnrollmentConfig, validateEnrollmentResponses } = require('../utils/enrollmentSchema');
const { findOwnedRider, assertOwnedPlaces, effectiveContactPhone, validContactPhone, publicRider, mapValuesToObject } = require('../utils/riders');
const { riderRoleForResolvedService } = require('../utils/riderRole');

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
  pickupPlaceId: enrollment.pickupPlaceId || null,
  dropoffPlaceId: enrollment.dropoffPlaceId || null,
  driver: driver ? driverSummary(driver, organization, vehicle, enrollment.status === 'ACTIVE') : null
});

async function resolveKeyContext(account, key, riderId) {
  const rider = await findOwnedRider(account, riderId);
  if (!rider) return { error: { status: 404, message: 'Rider not found' } };
  if (isThrottled(account._id)) {
    return { error: { status: 429, message: 'Too many incorrect keys. Please wait a few minutes and try again.' } };
  }

  const raw = String(key || '').trim();
  if (!raw) return { error: { status: 400, message: 'Please provide an enrollment key' } };
  const driverId = await findDriverIdByEnrollmentKey(raw);
  const driver = driverId ? await Driver.findById(driverId) : null;
  if (!driver || driver.isActive === false) {
    recordFailure(account._id);
    return { error: { status: 404, message: INVALID_KEY } };
  }
  clearFailures(account._id);

  const [organization, vehicle, existingEnrollment] = await Promise.all([
    driver.organization ? Organization.findById(driver.organization) : null,
    Vehicle.findOne({ driverId: driver._id }).select('vehicleId numberPlate routeId').lean(),
    DriverEnrollment.findOne({ studentId: rider._id, driverId: driver._id })
  ]);
  const organizationProfile = organization
    ? await RiderOrganizationProfile.findOne({ studentId: rider._id, organizationId: organization._id })
    : null;

  return { raw, rider, driver, organization, vehicle, existingEnrollment, organizationProfile };
}

exports.resolveEnrollmentKey = async (req, res, next) => {
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
    const rider = await findOwnedRider(req.user, req.query.riderId || req.query.studentId);
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    const enrollments = await DriverEnrollment.find({
      studentId: rider._id,
      status: { $in: ['ACTIVE', 'PENDING'] }
    }).sort({ createdAt: -1 }).lean();
    if (!enrollments.length) return res.status(200).json({
      success: true,
      rider: publicRider(rider, req.user),
      student: publicRider(rider, req.user),
      data: []
    });

    const driverIds = enrollments.map((item) => item.driverId);
    const drivers = await Driver.find({ _id: { $in: driverIds } }).select('name driverCode organization isActive phoneNumber').lean();
    const orgIds = drivers.map((driver) => driver.organization).filter(Boolean);
    const [organizations, vehicles] = await Promise.all([
      orgIds.length ? Organization.find({ _id: { $in: orgIds } }).select('name serviceType').lean() : [],
      Vehicle.find({ driverId: { $in: driverIds } }).select('vehicleId numberPlate routeId driverId').lean()
    ]);
    const driverById = new Map(drivers.map((driver) => [String(driver._id), driver]));
    const orgById = new Map(organizations.map((organization) => [String(organization._id), organization]));
    const vehicleByDriver = new Map(vehicles.map((vehicle) => [String(vehicle.driverId), vehicle]));
    const data = enrollments.map((enrollment) => {
      const driver = driverById.get(String(enrollment.driverId));
      return enrollmentSummary(enrollment, driver, driver?.organization ? orgById.get(String(driver.organization)) : null, vehicleByDriver.get(String(enrollment.driverId)));
    });
    return res.status(200).json({
      success: true,
      rider: publicRider(rider, req.user),
      student: publicRider(rider, req.user),
      data
    });
  } catch (error) { next(error); }
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
